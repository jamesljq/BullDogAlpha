"""Partitioned Parquet storage and lazy streaming data manager for 5-10 year datasets."""

import os
import shutil
from typing import Any, Dict, List, Optional, Union
import polars as pl

from src.alpha_engine.data.schema import (
    CANONICAL_SCHEMA,
    SYMBOL_COL,
    TIMESTAMP_COL,
    validate_and_normalize_schema,
)
from src.alpha_engine.data.validator import DataIntegrityValidator, ValidationError


class MarketDataManager:
  """Manages partitioned Parquet storage, cataloging, and lazy streaming queries."""

  def __init__(
      self,
      data_root: str,
      validator: Optional[DataIntegrityValidator] = None,
  ):
    """Initializes the MarketDataManager.

    Args:
        data_root: Root directory path for market data storage.
        validator: Optional DataIntegrityValidator for ingestion verification.
    """
    self.data_root = os.path.abspath(data_root)
    self.validator = validator or DataIntegrityValidator()
    os.makedirs(self.data_root, exist_ok=True)

  def _get_symbol_dir(self, symbol: str) -> str:
    return os.path.join(self.data_root, symbol.upper())

  def save_bars(
      self,
      df: pl.DataFrame,
      validate: bool = True,
      partition_by_year: bool = True,
  ) -> List[str]:
    """Stores market data into partitioned Parquet files.

    Args:
        df: Input DataFrame containing market data.
        validate: If True, performs rigorous data integrity validation before writing.
        partition_by_year: If True, partitions files by symbol and year (e.g. AAPL/2023.parquet).

    Returns:
        List of written Parquet file paths.

    Raises:
        ValidationError: If validation is enabled and data check fails.
    """
    norm_df = validate_and_normalize_schema(df)
    if validate:
      self.validator.validate(norm_df, raise_on_error=True)

    written_paths: List[str] = []
    symbols = norm_df[SYMBOL_COL].unique().to_list()

    # Extract year for partitioning
    with_year = norm_df.with_columns(
        pl.from_epoch(pl.col(TIMESTAMP_COL), time_unit="ms").dt.year().alias("_year")
    )

    for sym in symbols:
      sym_dir = self._get_symbol_dir(sym)
      os.makedirs(sym_dir, exist_ok=True)

      sym_df = with_year.filter(pl.col(SYMBOL_COL) == sym)

      if partition_by_year:
        years = sym_df["_year"].unique().to_list()
        for yr in years:
          yr_df = sym_df.filter(pl.col("_year") == yr).drop("_year").sort(TIMESTAMP_COL)
          file_path = os.path.join(sym_dir, f"{yr}.parquet")

          # Merge with existing data if file exists to support incremental ingestion
          if os.path.exists(file_path):
            existing_df = pl.read_parquet(file_path)
            combined = pl.concat([existing_df, yr_df]).unique(subset=[TIMESTAMP_COL, SYMBOL_COL]).sort(TIMESTAMP_COL)
            combined.write_parquet(file_path, compression="zstd")
          else:
            yr_df.write_parquet(file_path, compression="zstd")

          written_paths.append(file_path)
      else:
        file_path = os.path.join(sym_dir, "data.parquet")
        clean_sym_df = sym_df.drop("_year").sort(TIMESTAMP_COL)
        if os.path.exists(file_path):
          existing_df = pl.read_parquet(file_path)
          combined = pl.concat([existing_df, clean_sym_df]).unique(subset=[TIMESTAMP_COL, SYMBOL_COL]).sort(TIMESTAMP_COL)
          combined.write_parquet(file_path, compression="zstd")
        else:
          clean_sym_df.write_parquet(file_path, compression="zstd")
        written_paths.append(file_path)

    return written_paths

  def scan_bars(
      self,
      symbols: Union[str, List[str]],
      start_ts: Optional[int] = None,
      end_ts: Optional[int] = None,
  ) -> pl.LazyFrame:
    """Returns a Polars LazyFrame for zero-copy streaming of requested symbols and date range."""
    if isinstance(symbols, str):
      symbols = [symbols]

    symbols = [s.upper() for s in symbols]
    file_paths: List[str] = []

    for sym in symbols:
      sym_dir = self._get_symbol_dir(sym)
      if not os.path.exists(sym_dir):
        continue

      for f in os.listdir(sym_dir):
        if f.endswith(".parquet"):
          file_paths.append(os.path.join(sym_dir, f))

    if not file_paths:
      return pl.LazyFrame(schema=CANONICAL_SCHEMA)

    lazy_df = pl.scan_parquet(file_paths)

    filters = []
    if symbols:
      filters.append(pl.col(SYMBOL_COL).is_in(symbols))
    if start_ts is not None:
      filters.append(pl.col(TIMESTAMP_COL) >= start_ts)
    if end_ts is not None:
      filters.append(pl.col(TIMESTAMP_COL) <= end_ts)

    if filters:
      for f in filters:
        lazy_df = lazy_df.filter(f)

    return lazy_df.sort([TIMESTAMP_COL, SYMBOL_COL])

  def load_bars(
      self,
      symbols: Union[str, List[str]],
      start_ts: Optional[int] = None,
      end_ts: Optional[int] = None,
  ) -> pl.DataFrame:
    """Loads and materializes market data into memory for the requested symbols and date range."""
    return self.scan_bars(symbols, start_ts=start_ts, end_ts=end_ts).collect()

  def list_available_symbols(self) -> List[str]:
    """Lists all stored symbols in the data root."""
    if not os.path.exists(self.data_root):
      return []
    symbols = []
    for item in os.listdir(self.data_root):
      item_path = os.path.join(self.data_root, item)
      if os.path.isdir(item_path) and any(f.endswith(".parquet") for f in os.listdir(item_path)):
        symbols.append(item)
    return sorted(symbols)

  def get_symbol_metadata(self, symbol: str) -> Dict[str, Any]:
    """Retrieves metadata summary for a stored symbol."""
    sym = symbol.upper()
    sym_dir = self._get_symbol_dir(sym)
    if not os.path.exists(sym_dir):
      return {"symbol": sym, "exists": False, "row_count": 0}

    files = [os.path.join(sym_dir, f) for f in os.listdir(sym_dir) if f.endswith(".parquet")]
    if not files:
      return {"symbol": sym, "exists": False, "row_count": 0}

    lazy_df = pl.scan_parquet(files).filter(pl.col(SYMBOL_COL) == sym)
    stats = lazy_df.select([
        pl.len().alias("count"),
        pl.col(TIMESTAMP_COL).min().alias("min_ts"),
        pl.col(TIMESTAMP_COL).max().alias("max_ts"),
    ]).collect()

    row_count = int(stats["count"][0])
    min_ts = int(stats["min_ts"][0]) if row_count > 0 else None
    max_ts = int(stats["max_ts"][0]) if row_count > 0 else None

    return {
        "symbol": sym,
        "exists": True,
        "row_count": row_count,
        "min_timestamp": min_ts,
        "max_timestamp": max_ts,
        "file_count": len(files),
        "files": files,
    }

  def delete_symbol_data(self, symbol: str) -> bool:
    """Removes all stored data for a symbol."""
    sym_dir = self._get_symbol_dir(symbol)
    if os.path.exists(sym_dir):
      shutil.rmtree(sym_dir)
      return True
    return False
