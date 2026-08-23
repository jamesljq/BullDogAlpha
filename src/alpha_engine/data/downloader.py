"""Data fetcher interfaces, CSV ingestion, and multi-year synthetic market data generator."""

from abc import ABC, abstractmethod
import datetime
import math
from typing import Dict, List, Optional
import numpy as np
import polars as pl

from src.alpha_engine.data.schema import (
    ADJ_CLOSE_COL,
    CANONICAL_SCHEMA,
    CLOSE_COL,
    DIVIDEND_COL,
    HIGH_COL,
    LOW_COL,
    OPEN_COL,
    SPLIT_FACTOR_COL,
    SYMBOL_COL,
    TIMESTAMP_COL,
    VOLUME_COL,
    validate_and_normalize_schema,
)


class BaseDataFetcher(ABC):
  """Abstract base class for market data downloaders and providers."""

  @abstractmethod
  def fetch_bars(
      self,
      symbol: str,
      start_ts: int,
      end_ts: int,
      interval_ms: int = 86400000,
  ) -> pl.DataFrame:
    """Fetches historical market data bars for a given symbol and time window.

    Args:
        symbol: Ticker symbol (e.g., 'AAPL', 'BTCUSDT').
        start_ts: Inclusive start timestamp in epoch milliseconds.
        end_ts: Inclusive end timestamp in epoch milliseconds.
        interval_ms: Bar interval in milliseconds (default 1 day = 86,400,000 ms).

    Returns:
        Polars DataFrame normalized to canonical schema.
    """
    pass


class SyntheticDataGenerator(BaseDataFetcher):
  """High-fidelity synthetic market data generator.

  Uses Geometric Brownian Motion (GBM) with volatility regimes, intraday high/low
  spread modeling, volume correlation, and scheduled corporate actions (splits & dividends).
  """

  def __init__(
      self,
      annual_drift: float = 0.08,
      annual_volatility: float = 0.20,
      random_seed: Optional[int] = 42,
  ):
    """Initializes generator parameters.

    Args:
        annual_drift: Annualized expected price drift (e.g. 0.08 = 8%).
        annual_volatility: Annualized return volatility (e.g. 0.20 = 20%).
        random_seed: Random seed for deterministic reproducibility.
    """
    self.annual_drift = annual_drift
    self.annual_volatility = annual_volatility
    self.random_seed = random_seed

  def fetch_bars(
      self,
      symbol: str,
      start_ts: int,
      end_ts: int,
      interval_ms: int = 86400000,
      initial_price: float = 100.0,
      splits: Optional[Dict[int, float]] = None,
      dividends: Optional[Dict[int, float]] = None,
  ) -> pl.DataFrame:
    """Generates synthetic historical bars.

    Args:
        symbol: Ticker symbol.
        start_ts: Starting timestamp in epoch milliseconds.
        end_ts: Ending timestamp in epoch milliseconds.
        interval_ms: Bar interval in milliseconds.
        initial_price: Price at start_ts.
        splits: Optional map of timestamp (ms) -> split factor (e.g. {ts: 2.0} for 2:1 split).
        dividends: Optional map of timestamp (ms) -> cash dividend amount.

    Returns:
        Normalized canonical Polars DataFrame.
    """
    if start_ts >= end_ts:
      raise ValueError(f"start_ts ({start_ts}) must be strictly less than end_ts ({end_ts}).")

    if interval_ms <= 0:
      raise ValueError("interval_ms must be positive.")

    rng = np.random.default_rng(self.random_seed)

    timestamps = list(range(start_ts, end_ts + 1, interval_ms))
    n = len(timestamps)
    if n == 0:
      return pl.DataFrame(schema=CANONICAL_SCHEMA)

    # Time delta in years per step
    dt = interval_ms / (365.25 * 86400000.0)
    drift_step = (self.annual_drift - 0.5 * (self.annual_volatility ** 2)) * dt
    vol_step = self.annual_volatility * math.sqrt(dt)

    # Generate log returns
    random_shocks = rng.normal(0.0, 1.0, n)
    log_returns = drift_step + vol_step * random_shocks

    prices: List[float] = [initial_price]
    curr_price = initial_price

    splits_map = splits or {}
    dividends_map = dividends or {}

    split_col: List[float] = []
    div_col: List[float] = []

    # First bar
    split_col.append(splits_map.get(timestamps[0], 1.0))
    div_col.append(dividends_map.get(timestamps[0], 0.0))

    for i in range(1, n):
      ts = timestamps[i]
      ret = log_returns[i]
      curr_price = curr_price * math.exp(ret)

      # Apply split if scheduled
      split_factor = splits_map.get(ts, 1.0)
      if split_factor > 0 and split_factor != 1.0:
        curr_price /= split_factor

      div_amount = dividends_map.get(ts, 0.0)

      prices.append(max(0.01, curr_price))
      split_col.append(split_factor)
      div_col.append(div_amount)

    # Construct OHLCV bars
    opens = []
    highs = []
    lows = []
    closes = []
    volumes = []

    for i, close_p in enumerate(prices):
      if i == 0:
        open_p = close_p * (1.0 + rng.normal(0, 0.002))
      else:
        open_p = prices[i - 1] * (1.0 + rng.normal(0, 0.001))

      spread = abs(rng.normal(0.0, 0.005)) * close_p
      high_p = max(open_p, close_p) + spread
      low_p = max(0.01, min(open_p, close_p) - spread)

      # Volume correlated with volatility
      base_vol = 10000.0 * (1.0 + abs(random_shocks[i]) * 2.0)
      vol = max(100.0, base_vol + rng.normal(0, 1000.0))

      opens.append(float(open_p))
      highs.append(float(high_p))
      lows.append(float(low_p))
      closes.append(float(close_p))
      volumes.append(float(vol))

    df = pl.DataFrame({
        TIMESTAMP_COL: timestamps,
        SYMBOL_COL: [symbol] * n,
        OPEN_COL: opens,
        HIGH_COL: highs,
        LOW_COL: lows,
        CLOSE_COL: closes,
        VOLUME_COL: volumes,
        ADJ_CLOSE_COL: closes,  # initially equal to close, can be adjusted via CorporateActionAdjuster
        DIVIDEND_COL: div_col,
        SPLIT_FACTOR_COL: split_col,
    })

    return validate_and_normalize_schema(df)


class CSVDataFetcher(BaseDataFetcher):
  """Loads and standardizes market data from arbitrary CSV files."""

  def __init__(
      self,
      file_path: str,
      column_mapping: Optional[Dict[str, str]] = None,
      timestamp_format: Optional[str] = None,
  ):
    """Initializes CSV fetcher.

    Args:
        file_path: Path to the CSV file.
        column_mapping: Mapping from CSV header name to canonical column name.
        timestamp_format: Optional strftime format if timestamp is a datetime string.
    """
    self.file_path = file_path
    self.column_mapping = column_mapping or {}
    self.timestamp_format = timestamp_format

  def fetch_bars(
      self,
      symbol: str,
      start_ts: int,
      end_ts: int,
      interval_ms: int = 86400000,
  ) -> pl.DataFrame:
    """Reads CSV, maps columns, filters by timestamp range, and normalizes schema."""
    df = pl.read_csv(self.file_path)

    # Rename columns using provided mapping
    rename_dict = {orig: target for orig, target in self.column_mapping.items() if orig in df.columns}
    if rename_dict:
      df = df.rename(rename_dict)

    if SYMBOL_COL not in df.columns:
      df = df.with_columns(pl.lit(symbol).alias(SYMBOL_COL))

    # Parse timestamps if string or datetime
    if TIMESTAMP_COL in df.columns:
      if df[TIMESTAMP_COL].dtype == pl.String:
        if self.timestamp_format:
          df = df.with_columns(
              pl.col(TIMESTAMP_COL).str.to_datetime(self.timestamp_format).dt.epoch("ms").alias(TIMESTAMP_COL)
          )
        else:
          df = df.with_columns(
              pl.col(TIMESTAMP_COL).str.to_datetime().dt.epoch("ms").alias(TIMESTAMP_COL)
          )
      elif df[TIMESTAMP_COL].dtype in (pl.Datetime, pl.Date):
        df = df.with_columns(pl.col(TIMESTAMP_COL).dt.epoch("ms").alias(TIMESTAMP_COL))

    # Normalize schema
    norm_df = validate_and_normalize_schema(df)

    # Filter by symbol and timestamp range
    filtered = norm_df.filter(
        (pl.col(SYMBOL_COL) == symbol)
        & (pl.col(TIMESTAMP_COL) >= start_ts)
        & (pl.col(TIMESTAMP_COL) <= end_ts)
    ).sort(TIMESTAMP_COL)

    return filtered
