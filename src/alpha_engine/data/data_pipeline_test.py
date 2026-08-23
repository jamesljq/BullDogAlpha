"""Comprehensive unit tests for Alpha Engine data pipeline components."""

import os
import shutil
import tempfile
import unittest
import numpy as np
import polars as pl

from src.alpha_engine.data.adjuster import CorporateActionAdjuster
from src.alpha_engine.data.downloader import CSVDataFetcher, SyntheticDataGenerator
from src.alpha_engine.data.schema import (
    ADJ_CLOSE_COL,
    CANONICAL_SCHEMA,
    CLOSE_COL,
    DIVIDEND_COL,
    HIGH_COL,
    LOW_COL,
    MANDATORY_COLUMNS,
    OPEN_COL,
    SPLIT_FACTOR_COL,
    SYMBOL_COL,
    TIMESTAMP_COL,
    VOLUME_COL,
    validate_and_normalize_schema,
)
from src.alpha_engine.data.storage import MarketDataManager
from src.alpha_engine.data.validator import DataIntegrityValidator, ValidationError


class TestSchema(unittest.TestCase):
  """Tests for schema normalization and validation."""

  def test_validate_and_normalize_valid_dataframe(self):
    df = pl.DataFrame({
        TIMESTAMP_COL: [1672531199000],
        SYMBOL_COL: ["AAPL"],
        OPEN_COL: [150.0],
        HIGH_COL: [155.0],
        LOW_COL: [149.0],
        CLOSE_COL: [152.0],
        VOLUME_COL: [10000.0],
        ADJ_CLOSE_COL: [152.0],
        DIVIDEND_COL: [0.0],
        SPLIT_FACTOR_COL: [1.0],
    })
    normalized = validate_and_normalize_schema(df)
    self.assertEqual(normalized.columns, list(CANONICAL_SCHEMA.keys()))
    self.assertEqual(normalized.dtypes, list(CANONICAL_SCHEMA.values()))

  def test_auto_fill_optional_columns(self):
    # Missing adj_close, dividend, split_factor
    df = pl.DataFrame({
        TIMESTAMP_COL: [1672531199000],
        SYMBOL_COL: ["AAPL"],
        OPEN_COL: [150],
        HIGH_COL: [155],
        LOW_COL: [149],
        CLOSE_COL: [152.5],
        VOLUME_COL: [10000],
    })
    normalized = validate_and_normalize_schema(df)
    self.assertIn(ADJ_CLOSE_COL, normalized.columns)
    self.assertIn(DIVIDEND_COL, normalized.columns)
    self.assertIn(SPLIT_FACTOR_COL, normalized.columns)
    self.assertEqual(normalized[ADJ_CLOSE_COL][0], 152.5)
    self.assertEqual(normalized[DIVIDEND_COL][0], 0.0)
    self.assertEqual(normalized[SPLIT_FACTOR_COL][0], 1.0)

  def test_missing_mandatory_columns_raises(self):
    df = pl.DataFrame({
        TIMESTAMP_COL: [1672531199000],
        SYMBOL_COL: ["AAPL"],
        OPEN_COL: [150.0],
        # Missing high, low, close, volume
    })
    with self.assertRaises(ValueError) as ctx:
      validate_and_normalize_schema(df)
    self.assertIn("missing mandatory columns", str(ctx.exception))

  def test_none_input_raises(self):
    with self.assertRaises(ValueError):
      validate_and_normalize_schema(None)


class TestValidator(unittest.TestCase):
  """Tests for data sanity and integrity checks."""

  def setUp(self):
    self.validator = DataIntegrityValidator()

  def test_valid_dataset(self):
    df = pl.DataFrame({
        TIMESTAMP_COL: [1000, 2000, 3000],
        SYMBOL_COL: ["AAPL", "AAPL", "AAPL"],
        OPEN_COL: [100.0, 101.0, 102.0],
        HIGH_COL: [105.0, 106.0, 107.0],
        LOW_COL: [99.0, 100.0, 101.0],
        CLOSE_COL: [101.0, 102.0, 103.0],
        VOLUME_COL: [500.0, 600.0, 700.0],
        ADJ_CLOSE_COL: [101.0, 102.0, 103.0],
        DIVIDEND_COL: [0.0, 0.0, 0.0],
        SPLIT_FACTOR_COL: [1.0, 1.0, 1.0],
    })
    report = self.validator.validate(df, raise_on_error=True)
    self.assertTrue(report.is_valid)
    self.assertEqual(report.row_count, 3)
    self.assertEqual(report.symbols, ["AAPL"])
    self.assertEqual(report.min_timestamp, 1000)
    self.assertEqual(report.max_timestamp, 3000)

  def test_empty_dataset(self):
    df = pl.DataFrame(schema=CANONICAL_SCHEMA)
    report = self.validator.validate(df)
    self.assertFalse(report.is_valid)
    self.assertIn("empty", report.errors[0].lower())

    with self.assertRaises(ValidationError):
      self.validator.validate(df, raise_on_error=True)

  def test_null_or_nan_values(self):
    df = pl.DataFrame({
        TIMESTAMP_COL: [1000, 2000],
        SYMBOL_COL: ["AAPL", "AAPL"],
        OPEN_COL: [100.0, None],
        HIGH_COL: [105.0, 106.0],
        LOW_COL: [99.0, 100.0],
        CLOSE_COL: [101.0, float("nan")],
        VOLUME_COL: [500.0, 600.0],
        ADJ_CLOSE_COL: [101.0, 102.0],
        DIVIDEND_COL: [0.0, 0.0],
        SPLIT_FACTOR_COL: [1.0, 1.0],
    })
    report = self.validator.validate(df)
    self.assertFalse(report.is_valid)
    self.assertTrue(any("null" in err.lower() for err in report.errors))
    self.assertTrue(any("nan" in err.lower() for err in report.errors))

  def test_non_monotonic_timestamps(self):
    # Duplicate timestamps and retrograde order
    df = pl.DataFrame({
        TIMESTAMP_COL: [1000, 1000, 500],
        SYMBOL_COL: ["AAPL", "AAPL", "AAPL"],
        OPEN_COL: [100.0, 101.0, 102.0],
        HIGH_COL: [105.0, 106.0, 107.0],
        LOW_COL: [99.0, 100.0, 101.0],
        CLOSE_COL: [101.0, 102.0, 103.0],
        VOLUME_COL: [500.0, 600.0, 700.0],
        ADJ_CLOSE_COL: [101.0, 102.0, 103.0],
        DIVIDEND_COL: [0.0, 0.0, 0.0],
        SPLIT_FACTOR_COL: [1.0, 1.0, 1.0],
    })
    report = self.validator.validate(df)
    self.assertFalse(report.is_valid)
    self.assertTrue(any("non-increasing" in err.lower() for err in report.errors))

  def test_non_positive_prices(self):
    df = pl.DataFrame({
        TIMESTAMP_COL: [1000],
        SYMBOL_COL: ["AAPL"],
        OPEN_COL: [-10.0],
        HIGH_COL: [105.0],
        LOW_COL: [99.0],
        CLOSE_COL: [0.0],
        VOLUME_COL: [500.0],
        ADJ_CLOSE_COL: [0.0],
        DIVIDEND_COL: [0.0],
        SPLIT_FACTOR_COL: [1.0],
    })
    report = self.validator.validate(df)
    self.assertFalse(report.is_valid)
    self.assertTrue(any("non-positive price" in err.lower() for err in report.errors))

  def test_ohlc_inconsistencies(self):
    df = pl.DataFrame({
        TIMESTAMP_COL: [1000],
        SYMBOL_COL: ["AAPL"],
        OPEN_COL: [100.0],
        HIGH_COL: [95.0],  # High < Open
        LOW_COL: [99.0],
        CLOSE_COL: [101.0],
        VOLUME_COL: [500.0],
        ADJ_CLOSE_COL: [101.0],
        DIVIDEND_COL: [0.0],
        SPLIT_FACTOR_COL: [1.0],
    })
    report = self.validator.validate(df)
    self.assertFalse(report.is_valid)
    self.assertTrue(any("internal ohlc" in err.lower() for err in report.errors))

  def test_negative_volume(self):
    df = pl.DataFrame({
        TIMESTAMP_COL: [1000],
        SYMBOL_COL: ["AAPL"],
        OPEN_COL: [100.0],
        HIGH_COL: [105.0],
        LOW_COL: [99.0],
        CLOSE_COL: [101.0],
        VOLUME_COL: [-500.0],
        ADJ_CLOSE_COL: [101.0],
        DIVIDEND_COL: [0.0],
        SPLIT_FACTOR_COL: [1.0],
    })
    report = self.validator.validate(df)
    self.assertFalse(report.is_valid)
    self.assertTrue(any("negative volume" in err.lower() for err in report.errors))

  def test_disallow_zero_volume_mode(self):
    strict_val = DataIntegrityValidator(allow_zero_volume=False)
    df = pl.DataFrame({
        TIMESTAMP_COL: [1000],
        SYMBOL_COL: ["AAPL"],
        OPEN_COL: [100.0],
        HIGH_COL: [105.0],
        LOW_COL: [99.0],
        CLOSE_COL: [101.0],
        VOLUME_COL: [0.0],
        ADJ_CLOSE_COL: [101.0],
        DIVIDEND_COL: [0.0],
        SPLIT_FACTOR_COL: [1.0],
    })
    report = strict_val.validate(df)
    self.assertFalse(report.is_valid)
    self.assertTrue(any("zero/negative volume" in err.lower() for err in report.errors))

  def test_large_price_jump_warning(self):
    df = pl.DataFrame({
        TIMESTAMP_COL: [1000, 2000],
        SYMBOL_COL: ["AAPL", "AAPL"],
        OPEN_COL: [100.0, 200.0],
        HIGH_COL: [105.0, 210.0],
        LOW_COL: [99.0, 195.0],
        CLOSE_COL: [100.0, 200.0],  # 100% jump
        VOLUME_COL: [500.0, 600.0],
        ADJ_CLOSE_COL: [100.0, 200.0],
        DIVIDEND_COL: [0.0, 0.0],
        SPLIT_FACTOR_COL: [1.0, 1.0],
    })
    report = self.validator.validate(df)
    self.assertTrue(report.is_valid)  # Warnings do not invalidate
    self.assertTrue(len(report.warnings) > 0)

  def test_validator_missing_column_raise_on_error(self):
    df = pl.DataFrame({TIMESTAMP_COL: [1000]})
    with self.assertRaises(ValidationError):
      self.validator.validate(df, raise_on_error=True)


  def test_validator_ohlc_error_raise_on_error(self):
    df = pl.DataFrame({
        TIMESTAMP_COL: [1000],
        SYMBOL_COL: ["AAPL"],
        OPEN_COL: [100.0],
        HIGH_COL: [90.0],  # High < Low
        LOW_COL: [95.0],
        CLOSE_COL: [92.0],
        VOLUME_COL: [500.0],
        ADJ_CLOSE_COL: [92.0],
        DIVIDEND_COL: [0.0],
        SPLIT_FACTOR_COL: [1.0],
    })
    with self.assertRaises(ValidationError):
      self.validator.validate(df, raise_on_error=True)


class TestCorporateActionAdjuster(unittest.TestCase):

  """Tests for split and dividend backward adjustments."""

  def test_empty_dataframe(self):
    df = pl.DataFrame(schema=CANONICAL_SCHEMA)
    adjusted = CorporateActionAdjuster.adjust_dataframe(df)
    self.assertEqual(adjusted.height, 0)

  def test_stock_split_adjustment(self):
    # Day 1: Close = 200
    # Day 2: 2-for-1 split occurred (split_factor = 2.0), Close = 100
    # Backward adjustment: Day 1 prices should be divided by 2 (adj_factor = 0.5)
    df = pl.DataFrame({
        TIMESTAMP_COL: [1000, 2000],
        SYMBOL_COL: ["AAPL", "AAPL"],
        OPEN_COL: [195.0, 98.0],
        HIGH_COL: [205.0, 102.0],
        LOW_COL: [190.0, 95.0],
        CLOSE_COL: [200.0, 100.0],
        VOLUME_COL: [1000.0, 2000.0],
        ADJ_CLOSE_COL: [200.0, 100.0],
        DIVIDEND_COL: [0.0, 0.0],
        SPLIT_FACTOR_COL: [1.0, 2.0],
    })

    adjusted = CorporateActionAdjuster.adjust_dataframe(df, apply_to_ohlc=False)
    # Day 1 adj_close should be 200 * 0.5 = 100
    # Day 2 adj_close should be 100 * 1.0 = 100
    self.assertAlmostEqual(adjusted[ADJ_CLOSE_COL][0], 100.0, delta=1e-6)
    self.assertAlmostEqual(adjusted[ADJ_CLOSE_COL][1], 100.0, delta=1e-6)
    # Day 1 adj_volume should be 1000 / 0.5 = 2000
    self.assertAlmostEqual(adjusted["adj_volume"][0], 2000.0, delta=1e-6)

  def test_apply_to_ohlc_in_place(self):
    df = pl.DataFrame({
        TIMESTAMP_COL: [1000, 2000],
        SYMBOL_COL: ["AAPL", "AAPL"],
        OPEN_COL: [200.0, 100.0],
        HIGH_COL: [210.0, 105.0],
        LOW_COL: [190.0, 95.0],
        CLOSE_COL: [200.0, 100.0],
        VOLUME_COL: [1000.0, 2000.0],
        ADJ_CLOSE_COL: [200.0, 100.0],
        DIVIDEND_COL: [0.0, 0.0],
        SPLIT_FACTOR_COL: [1.0, 2.0],
    })
    adjusted = CorporateActionAdjuster.adjust_dataframe(df, apply_to_ohlc=True)
    self.assertAlmostEqual(adjusted[OPEN_COL][0], 100.0, delta=1e-6)
    self.assertAlmostEqual(adjusted[CLOSE_COL][0], 100.0, delta=1e-6)
    self.assertAlmostEqual(adjusted[VOLUME_COL][0], 2000.0, delta=1e-6)

  def test_cash_dividend_adjustment(self):
    # Day 1: Close = 100.0
    # Day 2: Dividend = 5.0 (5% dividend payout), Close = 95.0
    # Div multiplier = (1 - 5/100) = 0.95
    # Day 1 adj_close = 100 * 0.95 = 95.0
    df = pl.DataFrame({
        TIMESTAMP_COL: [1000, 2000],
        SYMBOL_COL: ["MSFT", "MSFT"],
        OPEN_COL: [98.0, 95.0],
        HIGH_COL: [102.0, 98.0],
        LOW_COL: [97.0, 94.0],
        CLOSE_COL: [100.0, 95.0],
        VOLUME_COL: [5000.0, 5000.0],
        ADJ_CLOSE_COL: [100.0, 95.0],
        DIVIDEND_COL: [0.0, 5.0],
        SPLIT_FACTOR_COL: [1.0, 1.0],
    })
    adjusted = CorporateActionAdjuster.adjust_dataframe(df)
    self.assertAlmostEqual(adjusted[ADJ_CLOSE_COL][0], 95.0, delta=1e-6)
    self.assertAlmostEqual(adjusted[ADJ_CLOSE_COL][1], 95.0, delta=1e-6)


class TestDownloaderAndGenerator(unittest.TestCase):
  """Tests for SyntheticDataGenerator and CSVDataFetcher."""

  def setUp(self):
    self.temp_dir = tempfile.TemporaryDirectory()

  def tearDown(self):
    self.temp_dir.cleanup()

  def test_synthetic_multi_year_generation(self):
    gen = SyntheticDataGenerator(annual_drift=0.10, annual_volatility=0.15, random_seed=123)
    # 5-year simulation at 1-day interval
    start_ts = 1577836800000  # 2020-01-01
    end_ts = start_ts + 5 * 365 * 86400000

    df = gen.fetch_bars("AAPL", start_ts, end_ts, interval_ms=86400000, initial_price=100.0)
    self.assertGreater(df.height, 1800)
    self.assertEqual(df[SYMBOL_COL][0], "AAPL")

    # Validate output data integrity
    validator = DataIntegrityValidator()
    report = validator.validate(df, raise_on_error=True)
    self.assertTrue(report.is_valid)

  def test_synthetic_scheduled_splits(self):
    gen = SyntheticDataGenerator(random_seed=42)
    start_ts = 1000
    end_ts = 5000
    split_ts = 3000

    df = gen.fetch_bars(
        "TSLA",
        start_ts,
        end_ts,
        interval_ms=1000,
        initial_price=200.0,
        splits={split_ts: 2.0},
    )
    self.assertEqual(df.height, 5)
    split_row = df.filter(pl.col(TIMESTAMP_COL) == split_ts)
    self.assertEqual(split_row[SPLIT_FACTOR_COL][0], 2.0)

  def test_synthetic_invalid_inputs(self):
    gen = SyntheticDataGenerator()
    with self.assertRaises(ValueError):
      gen.fetch_bars("AAPL", 5000, 1000)  # start >= end
    with self.assertRaises(ValueError):
      gen.fetch_bars("AAPL", 1000, 2000, interval_ms=0)

  def test_csv_fetcher_with_iso_datetime(self):
    csv_path = os.path.join(self.temp_dir.name, "test_market.csv")
    csv_content = """Date,Symbol,Open,High,Low,Close,Volume
2023-01-01T00:00:00,NVDA,150.0,155.0,148.0,152.0,10000
2023-01-02T00:00:00,NVDA,152.0,158.0,151.0,157.0,12000
"""
    with open(csv_path, "w") as f:
      f.write(csv_content)

    mapping = {
        "Date": TIMESTAMP_COL,
        "Symbol": SYMBOL_COL,
        "Open": OPEN_COL,
        "High": HIGH_COL,
        "Low": LOW_COL,
        "Close": CLOSE_COL,
        "Volume": VOLUME_COL,
    }
    fetcher = CSVDataFetcher(csv_path, column_mapping=mapping)
    df = fetcher.fetch_bars("NVDA", start_ts=0, end_ts=2000000000000)
    self.assertEqual(df.height, 2)
    self.assertEqual(df[SYMBOL_COL][0], "NVDA")
    self.assertEqual(df[OPEN_COL][0], 150.0)


  def test_csv_fetcher_with_datetime_and_standard_formats(self):
    csv_path = os.path.join(self.temp_dir.name, "test_market_std.csv")
    csv_content = """Date,Symbol,Open,High,Low,Close,Volume
2023-01-01 00:00:00,NVDA,150.0,155.0,148.0,152.0,10000
2023-01-02 00:00:00,NVDA,152.0,158.0,151.0,157.0,12000
"""
    with open(csv_path, "w") as f:
      f.write(csv_content)

    mapping = {
        "Date": TIMESTAMP_COL,
        "Symbol": SYMBOL_COL,
        "Open": OPEN_COL,
        "High": HIGH_COL,
        "Low": LOW_COL,
        "Close": CLOSE_COL,
        "Volume": VOLUME_COL,
    }
    fetcher = CSVDataFetcher(csv_path, column_mapping=mapping, timestamp_format="%Y-%m-%d %H:%M:%S")
    df = fetcher.fetch_bars("NVDA", start_ts=0, end_ts=2000000000000)
    self.assertEqual(df.height, 2)

    # Test with standard auto ISO parse without timestamp_format
    fetcher_auto = CSVDataFetcher(csv_path, column_mapping=mapping)
    df_auto = fetcher_auto.fetch_bars("NVDA", start_ts=0, end_ts=2000000000000)
    self.assertEqual(df_auto.height, 2)


class TestMarketDataManager(unittest.TestCase):
  """Tests for partitioned Parquet storage and lazy querying."""

  def setUp(self):
    self.temp_dir = tempfile.TemporaryDirectory()
    self.data_manager = MarketDataManager(data_root=self.temp_dir.name)

  def tearDown(self):
    self.temp_dir.cleanup()

  def test_save_and_load_partitioned_bars(self):
    # Year 2021: ts = 1609459200000
    # Year 2022: ts = 1640995200000
    df = pl.DataFrame({
        TIMESTAMP_COL: [1609459200000, 1640995200000],
        SYMBOL_COL: ["GOOG", "GOOG"],
        OPEN_COL: [100.0, 120.0],
        HIGH_COL: [105.0, 125.0],
        LOW_COL: [98.0, 118.0],
        CLOSE_COL: [102.0, 122.0],
        VOLUME_COL: [1000.0, 2000.0],
        ADJ_CLOSE_COL: [102.0, 122.0],
        DIVIDEND_COL: [0.0, 0.0],
        SPLIT_FACTOR_COL: [1.0, 1.0],
    })

    written_paths = self.data_manager.save_bars(df, partition_by_year=True)
    self.assertEqual(len(written_paths), 2)
    self.assertTrue(any("2021.parquet" in p for p in written_paths))
    self.assertTrue(any("2022.parquet" in p for p in written_paths))

    # Query with date filter
    loaded_2021 = self.data_manager.load_bars("GOOG", start_ts=1609459200000, end_ts=1609459200000)
    self.assertEqual(loaded_2021.height, 1)
    self.assertEqual(loaded_2021[CLOSE_COL][0], 102.0)

    # Query all
    loaded_all = self.data_manager.load_bars(["GOOG"])
    self.assertEqual(loaded_all.height, 2)

  def test_incremental_deduplication(self):
    df = pl.DataFrame({
        TIMESTAMP_COL: [1609459200000],
        SYMBOL_COL: ["GOOG"],
        OPEN_COL: [100.0],
        HIGH_COL: [105.0],
        LOW_COL: [98.0],
        CLOSE_COL: [102.0],
        VOLUME_COL: [1000.0],
    })
    self.data_manager.save_bars(df)
    # Re-save identical bar with slight update
    self.data_manager.save_bars(df)
    loaded = self.data_manager.load_bars("GOOG")
    self.assertEqual(loaded.height, 1)

  def test_unpartitioned_save_and_incremental(self):
    df1 = pl.DataFrame({
        TIMESTAMP_COL: [1609459200000],
        SYMBOL_COL: ["AMZN"],
        OPEN_COL: [100.0],
        HIGH_COL: [105.0],
        LOW_COL: [98.0],
        CLOSE_COL: [102.0],
        VOLUME_COL: [1000.0],
    })
    written = self.data_manager.save_bars(df1, partition_by_year=False)
    self.assertEqual(len(written), 1)
    self.assertTrue(written[0].endswith("data.parquet"))

    # Incremental update on unpartitioned
    df2 = pl.DataFrame({
        TIMESTAMP_COL: [1609459260000],
        SYMBOL_COL: ["AMZN"],
        OPEN_COL: [102.0],
        HIGH_COL: [107.0],
        LOW_COL: [101.0],
        CLOSE_COL: [105.0],
        VOLUME_COL: [1500.0],
    })
    self.data_manager.save_bars(df2, partition_by_year=False)
    loaded = self.data_manager.load_bars("AMZN")
    self.assertEqual(loaded.height, 2)

  def test_scan_bars_empty_and_filters(self):
    # Scan non-existent symbol
    lazy = self.data_manager.scan_bars("UNKNOWN")
    self.assertEqual(lazy.collect().height, 0)

  def test_catalog_metadata_and_delete(self):
    df = pl.DataFrame({
        TIMESTAMP_COL: [1609459200000, 1609459260000],
        SYMBOL_COL: ["MSFT", "MSFT"],
        OPEN_COL: [200.0, 201.0],
        HIGH_COL: [205.0, 206.0],
        LOW_COL: [198.0, 199.0],
        CLOSE_COL: [202.0, 203.0],
        VOLUME_COL: [1000.0, 1200.0],
    })
    self.data_manager.save_bars(df)

    symbols = self.data_manager.list_available_symbols()
    self.assertEqual(symbols, ["MSFT"])

    meta = self.data_manager.get_symbol_metadata("MSFT")
    self.assertTrue(meta["exists"])
    self.assertEqual(meta["row_count"], 2)
    self.assertEqual(meta["min_timestamp"], 1609459200000)
    self.assertEqual(meta["max_timestamp"], 1609459260000)

    # Empty directory inside symbol directory edge case
    empty_sym_dir = os.path.join(self.temp_dir.name, "EMPTY_SYM")
    os.makedirs(empty_sym_dir, exist_ok=True)
    meta_empty_dir = self.data_manager.get_symbol_metadata("EMPTY_SYM")
    self.assertFalse(meta_empty_dir["exists"])

    # Non-existent symbol metadata
    meta_empty = self.data_manager.get_symbol_metadata("NONEXISTENT")
    self.assertFalse(meta_empty["exists"])

    # Non-existent root check for list_available_symbols
    dm_no_root = MarketDataManager(data_root=os.path.join(self.temp_dir.name, "none"))
    shutil.rmtree(dm_no_root.data_root)
    self.assertEqual(dm_no_root.list_available_symbols(), [])

    # Delete
    deleted = self.data_manager.delete_symbol_data("MSFT")
    self.assertTrue(deleted)
    self.assertEqual(self.data_manager.list_available_symbols(), [])
    self.assertFalse(self.data_manager.delete_symbol_data("MSFT"))


if __name__ == "__main__":
  unittest.main()

