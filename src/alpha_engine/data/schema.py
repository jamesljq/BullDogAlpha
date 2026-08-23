"""Canonical schema definitions and normalization for historical market data."""

from typing import Dict, Final, List
import polars as pl

# Canonical Column Name Constants
TIMESTAMP_COL: Final[str] = "timestamp"
SYMBOL_COL: Final[str] = "symbol"
OPEN_COL: Final[str] = "open"
HIGH_COL: Final[str] = "high"
LOW_COL: Final[str] = "low"
CLOSE_COL: Final[str] = "close"
VOLUME_COL: Final[str] = "volume"
ADJ_CLOSE_COL: Final[str] = "adj_close"
DIVIDEND_COL: Final[str] = "dividend"
SPLIT_FACTOR_COL: Final[str] = "split_factor"

MANDATORY_COLUMNS: Final[List[str]] = [
    TIMESTAMP_COL,
    SYMBOL_COL,
    OPEN_COL,
    HIGH_COL,
    LOW_COL,
    CLOSE_COL,
    VOLUME_COL,
]

CANONICAL_SCHEMA: Final[Dict[str, pl.DataType]] = {
    TIMESTAMP_COL: pl.Int64,
    SYMBOL_COL: pl.String,
    OPEN_COL: pl.Float64,
    HIGH_COL: pl.Float64,
    LOW_COL: pl.Float64,
    CLOSE_COL: pl.Float64,
    VOLUME_COL: pl.Float64,
    ADJ_CLOSE_COL: pl.Float64,
    DIVIDEND_COL: pl.Float64,
    SPLIT_FACTOR_COL: pl.Float64,
}


def validate_and_normalize_schema(df: pl.DataFrame) -> pl.DataFrame:
  """Validates that DataFrame contains all mandatory columns and standardizes types.

  Missing optional columns (adj_close, dividend, split_factor) are automatically
  populated with neutral defaults (adj_close = close, dividend = 0.0,
  split_factor = 1.0).

  Args:
      df: The input Polars DataFrame.

  Returns:
      A normalized Polars DataFrame adhering to the canonical schema.

  Raises:
      ValueError: If any mandatory column is missing or DataFrame is invalid.
  """
  if df is None:
    raise ValueError("Input DataFrame cannot be None.")

  existing_cols = df.columns
  missing_mandatory = [col for col in MANDATORY_COLUMNS if col not in existing_cols]
  if missing_mandatory:
    raise ValueError(f"DataFrame is missing mandatory columns: {missing_mandatory}")

  # Add missing optional columns with defaults
  expressions = []
  if ADJ_CLOSE_COL not in existing_cols:
    expressions.append(pl.col(CLOSE_COL).cast(pl.Float64).alias(ADJ_CLOSE_COL))
  if DIVIDEND_COL not in existing_cols:
    expressions.append(pl.lit(0.0, dtype=pl.Float64).alias(DIVIDEND_COL))
  if SPLIT_FACTOR_COL not in existing_cols:
    expressions.append(pl.lit(1.0, dtype=pl.Float64).alias(SPLIT_FACTOR_COL))

  if expressions:
    df = df.with_columns(expressions)

  # Cast all canonical columns to expected types and select them in canonical order
  cast_exprs = [pl.col(col).cast(dtype) for col, dtype in CANONICAL_SCHEMA.items()]
  return df.select(cast_exprs)
