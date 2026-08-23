"""Data integrity, monotonicity, and price sanity validator."""

from dataclasses import dataclass
from typing import Dict, List, Optional
import polars as pl

from src.alpha_engine.data.schema import (
    CLOSE_COL,
    HIGH_COL,
    LOW_COL,
    OPEN_COL,
    SYMBOL_COL,
    TIMESTAMP_COL,
    VOLUME_COL,
)


class ValidationError(Exception):
  """Raised when historical market data violates integrity constraints."""
  pass


@dataclass(frozen=True)
class ValidationReport:
  """Summary of dataset validation checks."""
  is_valid: bool
  row_count: int
  symbols: List[str]
  errors: List[str]
  warnings: List[str]
  min_timestamp: Optional[int]
  max_timestamp: Optional[int]


class DataIntegrityValidator:
  """Performs rigorous sanity checks on historical market data."""

  def __init__(
      self,
      allow_zero_volume: bool = True,
      max_price_jump_ratio: float = 0.5,
  ):
    """Initializes the validator.

    Args:
        allow_zero_volume: Whether volume of 0 is considered valid (e.g. for
          halts or forward-fill).
        max_price_jump_ratio: Warning threshold for single-bar price movement
          relative to previous close without recorded split (default 50%).
    """
    self.allow_zero_volume = allow_zero_volume
    self.max_price_jump_ratio = max_price_jump_ratio

  def validate(
      self,
      df: pl.DataFrame,
      raise_on_error: bool = False,
  ) -> ValidationReport:
    """Validates a DataFrame of market data.

    Args:
        df: Input market data DataFrame.
        raise_on_error: If True, raises ValidationError on the first critical
          error.

    Returns:
        ValidationReport containing status, errors, and warnings.

    Raises:
        ValidationError: If raise_on_error is True and validation fails.
    """
    errors: List[str] = []
    warnings: List[str] = []

    if df is None or df.height == 0:
      errors.append("Dataset is empty.")
      report = ValidationReport(
          is_valid=False,
          row_count=0,
          symbols=[],
          errors=errors,
          warnings=warnings,
          min_timestamp=None,
          max_timestamp=None,
      )
      if raise_on_error:
        raise ValidationError("; ".join(errors))
      return report

    # 1. Null / NaN checks across required columns
    for col in [TIMESTAMP_COL, SYMBOL_COL, OPEN_COL, HIGH_COL, LOW_COL, CLOSE_COL, VOLUME_COL]:
      if col not in df.columns:
        errors.append(f"Missing required column '{col}'.")
        continue
      null_count = df.select(pl.col(col).is_null().sum()).item()
      if null_count > 0:
        errors.append(f"Column '{col}' contains {null_count} null value(s).")
      
      # Check NaN for float columns
      if col in [OPEN_COL, HIGH_COL, LOW_COL, CLOSE_COL, VOLUME_COL]:
        nan_count = df.select(pl.col(col).is_nan().sum()).item()
        if nan_count > 0:
          errors.append(f"Column '{col}' contains {nan_count} NaN value(s).")

    if errors and raise_on_error:
      raise ValidationError("; ".join(errors))

    symbols = df[SYMBOL_COL].unique().to_list()
    min_ts = df[TIMESTAMP_COL].min()
    max_ts = df[TIMESTAMP_COL].max()

    # 2. Per-symbol checks: Monotonic timestamps & price bounds
    for sym in symbols:
      sym_df = df.filter(pl.col(SYMBOL_COL) == sym).sort(TIMESTAMP_COL)

      # Timestamp duplicate & ordering checks
      ts_series = sym_df[TIMESTAMP_COL]
      diffs = ts_series.diff()
      
      # Check for non-positive time differences (duplicates or retrograde time)
      non_positive_ts = diffs.slice(1).filter(diffs.slice(1) <= 0)
      if len(non_positive_ts) > 0:
        errors.append(
            f"Symbol '{sym}' has {len(non_positive_ts)} non-increasing or duplicate timestamp(s)."
        )

      # Check price sanity (positive values)
      non_positive_prices = sym_df.filter(
          (pl.col(OPEN_COL) <= 0)
          | (pl.col(HIGH_COL) <= 0)
          | (pl.col(LOW_COL) <= 0)
          | (pl.col(CLOSE_COL) <= 0)
      )
      if non_positive_prices.height > 0:
        errors.append(
            f"Symbol '{sym}' contains {non_positive_prices.height} bar(s) with non-positive price values."
        )

      # Check OHLC internal consistency
      ohlc_violations = sym_df.filter(
          (pl.col(HIGH_COL) < pl.col(LOW_COL))
          | (pl.col(HIGH_COL) < pl.col(OPEN_COL))
          | (pl.col(HIGH_COL) < pl.col(CLOSE_COL))
          | (pl.col(LOW_COL) > pl.col(OPEN_COL))
          | (pl.col(LOW_COL) > pl.col(CLOSE_COL))
      )
      if ohlc_violations.height > 0:
        errors.append(
            f"Symbol '{sym}' contains {ohlc_violations.height} bar(s) with internal OHLC relationship violations (e.g. High < Low)."
        )

      # Check Volume
      if not self.allow_zero_volume:
        zero_vol = sym_df.filter(pl.col(VOLUME_COL) <= 0)
        if zero_vol.height > 0:
          errors.append(f"Symbol '{sym}' contains {zero_vol.height} bar(s) with zero/negative volume.")
      else:
        negative_vol = sym_df.filter(pl.col(VOLUME_COL) < 0)
        if negative_vol.height > 0:
          errors.append(f"Symbol '{sym}' contains {negative_vol.height} bar(s) with negative volume.")

      # Price jump warnings
      if sym_df.height > 1:
        close_series = sym_df[CLOSE_COL]
        close_diff_pct = (close_series.diff() / close_series.shift(1)).abs().slice(1)
        large_jumps = close_diff_pct.filter(close_diff_pct > self.max_price_jump_ratio)
        if len(large_jumps) > 0:
          warnings.append(
              f"Symbol '{sym}' has {len(large_jumps)} bar(s) with single-step price jumps > {self.max_price_jump_ratio * 100:.0f}%."
          )

    is_valid = len(errors) == 0
    if not is_valid and raise_on_error:
      raise ValidationError("; ".join(errors))

    return ValidationReport(
        is_valid=is_valid,
        row_count=df.height,
        symbols=symbols,
        errors=errors,
        warnings=warnings,
        min_timestamp=min_ts,
        max_timestamp=max_ts,
    )
