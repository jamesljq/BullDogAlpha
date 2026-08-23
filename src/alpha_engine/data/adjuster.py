"""Corporate action adjustment (splits and cash dividends) for historical market data."""

from typing import List
import polars as pl

from src.alpha_engine.data.schema import (
    ADJ_CLOSE_COL,
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


class CorporateActionAdjuster:
  """Calculates backward or forward corporate action adjustments on price and volume series."""

  @classmethod
  def compute_adjustment_factors(
      cls,
      df: pl.DataFrame,
  ) -> pl.DataFrame:
    """Computes backward adjustment multipliers for a normalized single-symbol DataFrame.

    Backward adjustment preserves the most recent prices and scales historical prices down/up
    to reflect splits and cash dividends continuously.

    Args:
        df: Single-symbol Polars DataFrame sorted chronologically.

    Returns:
        DataFrame with an additional 'adj_factor' and 'split_adj_factor' column.
    """
    if df.height == 0:
      return df.with_columns([
          pl.lit(1.0, dtype=pl.Float64).alias("adj_factor"),
          pl.lit(1.0, dtype=pl.Float64).alias("split_adj_factor"),
      ])

    # Convert to Python list of records or iterate backwards to accurately compute cumulative compound factors
    # For high performance with Polars, we can compute per-step ratio factors:
    # step_factor = (1 / split_factor_next) * (1 - dividend_next / close_current)
    n = df.height
    closes = df[CLOSE_COL].to_list()
    dividends = df[DIVIDEND_COL].to_list()
    splits = df[SPLIT_FACTOR_COL].to_list()

    adj_factors: List[float] = [1.0] * n
    split_adj_factors: List[float] = [1.0] * n

    current_adj = 1.0
    current_split_adj = 1.0

    # Traverse from newest (index n-1) to oldest (index 0)
    for i in range(n - 2, -1, -1):
      next_split = splits[i + 1]
      next_div = dividends[i + 1]
      prev_close = closes[i]

      # Split ratio: if 2-for-1 split occurred at i+1, past prices must be divided by 2
      split_multiplier = (1.0 / next_split) if next_split > 0 else 1.0

      # Dividend ratio
      if next_div > 0.0 and prev_close > 0.0:
        div_multiplier = max(0.0, 1.0 - (next_div / prev_close))
      else:
        div_multiplier = 1.0

      current_split_adj *= split_multiplier
      current_adj *= (split_multiplier * div_multiplier)

      split_adj_factors[i] = current_split_adj
      adj_factors[i] = current_adj

    return df.with_columns([
        pl.Series("adj_factor", adj_factors, dtype=pl.Float64),
        pl.Series("split_adj_factor", split_adj_factors, dtype=pl.Float64),
    ])

  @classmethod
  def adjust_dataframe(
      cls,
      df: pl.DataFrame,
      apply_to_ohlc: bool = False,
  ) -> pl.DataFrame:
    """Adjusts market data across all symbols for stock splits and cash dividends.

    Args:
        df: Input raw or normalized DataFrame.
        apply_to_ohlc: If True, replaces open, high, low, close with adjusted values
                       and adjusts volume by split factor. If False, updates 'adj_close'
                       and adds 'adj_open', 'adj_high', 'adj_low', 'adj_volume'.

    Returns:
        Adjusted Polars DataFrame.
    """
    norm_df = validate_and_normalize_schema(df)
    symbols = norm_df[SYMBOL_COL].unique().to_list()

    adjusted_dfs = []
    for sym in symbols:
      sym_df = norm_df.filter(pl.col(SYMBOL_COL) == sym).sort(TIMESTAMP_COL)
      with_factors = cls.compute_adjustment_factors(sym_df)

      if apply_to_ohlc:
        adjusted = with_factors.with_columns([
            (pl.col(OPEN_COL) * pl.col("adj_factor")).alias(OPEN_COL),
            (pl.col(HIGH_COL) * pl.col("adj_factor")).alias(HIGH_COL),
            (pl.col(LOW_COL) * pl.col("adj_factor")).alias(LOW_COL),
            (pl.col(CLOSE_COL) * pl.col("adj_factor")).alias(CLOSE_COL),
            (pl.col(CLOSE_COL) * pl.col("adj_factor")).alias(ADJ_CLOSE_COL),
            (pl.col(VOLUME_COL) / pl.col("split_adj_factor")).alias(VOLUME_COL),
        ]).drop(["adj_factor", "split_adj_factor"])
      else:
        adjusted = with_factors.with_columns([
            (pl.col(OPEN_COL) * pl.col("adj_factor")).alias("adj_open"),
            (pl.col(HIGH_COL) * pl.col("adj_factor")).alias("adj_high"),
            (pl.col(LOW_COL) * pl.col("adj_factor")).alias("adj_low"),
            (pl.col(CLOSE_COL) * pl.col("adj_factor")).alias(ADJ_CLOSE_COL),
            (pl.col(VOLUME_COL) / pl.col("split_adj_factor")).alias("adj_volume"),
        ]).drop(["adj_factor", "split_adj_factor"])

      adjusted_dfs.append(adjusted)

    if not adjusted_dfs:
      return norm_df

    return pl.concat(adjusted_dfs).sort([TIMESTAMP_COL, SYMBOL_COL])
