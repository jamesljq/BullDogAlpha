"""Comprehensive unit tests for Backtest Engine, Execution Models, and Quant Analytics."""

import datetime
import math
import os
import tempfile
import unittest
import numpy as np
import polars as pl


from src.alpha_engine.analytics import PerformanceAnalytics, PerformanceReport, TradeRecord
from src.alpha_engine.backtest_driver import (
    BacktestContext,
    BarDict,
    CommissionModel,
    SlippageModel,
    compute_performance_metrics,
    run_backtest_session,
)
from src.alpha_engine.data.schema import (
    CLOSE_COL,
    HIGH_COL,
    LOW_COL,
    OPEN_COL,
    SYMBOL_COL,
    TIMESTAMP_COL,
    VOLUME_COL,
)
from src.alpha_engine.data.storage import MarketDataManager
from src.alpha_engine.strategies.base import BaseStrategy, SubPortfolio


class DummyTrendStrategy(BaseStrategy):
  """A dummy trading strategy that buys or sells based on price levels."""

  def __init__(self, ctx, symbol="AAPL"):
    super().__init__(ctx)
    self.symbol = symbol
    self.buy_done = False
    self.sell_done = False

  def on_initialize(self, ctx) -> None:
    pass

  def on_bar(self, bar_dict) -> None:
    if self.symbol not in bar_dict:
      return
    bar = bar_dict[self.symbol]
    close = bar.close

    # Simple signal logic to trigger execution
    if close > 150.0 and not self.buy_done:
      self.ctx.submit_order(self.symbol, 100, "BUY", order_type="MARKET")
      self.buy_done = True
    elif close > 153.0 and not self.sell_done:
      self.ctx.submit_order(self.symbol, 50, "SELL", order_type="MARKET")
      self.sell_done = True

  def on_order_status(self, order_response) -> None:
    pass


class MultiAssetLimitStrategy(BaseStrategy):
  """A strategy placing limit orders across multiple symbols."""

  def __init__(self, ctx):
    super().__init__(ctx)
    self.placed = False

  def on_bar(self, bar_dict) -> None:
    if not self.placed:
      if "AAPL" in bar_dict:
        # Place limit buy below open
        self.ctx.submit_order("AAPL", 50, "BUY", price=149.5, order_type="LIMIT")
      if "MSFT" in bar_dict:
        # Place limit sell above open
        self.ctx.submit_order("MSFT", 30, "SELL", price=252.0, order_type="LIMIT")
      self.placed = True

  def on_order_status(self, order_response) -> None:
    pass


class TestSubPortfolio(unittest.TestCase):
  """Tests for position tracking, cost basis, realized P&L, and short selling."""

  def test_long_accumulation_and_close(self):
    port = SubPortfolio(initial_cash=10000.0)

    # Buy 10 @ 100
    pnl1 = port.process_fill("AAPL", 10, "BUY", 100.0, commission=1.0)
    self.assertEqual(pnl1, 0.0)
    self.assertEqual(port.positions["AAPL"], 10)
    self.assertAlmostEqual(port.cost_basis["AAPL"], 100.0, delta=1e-6)
    self.assertAlmostEqual(port.cash, 10000.0 - 1001.0, delta=1e-6)

    # Buy 10 @ 110 (weighted average cost basis should be 105.0)
    pnl2 = port.process_fill("AAPL", 10, "BUY", 110.0, commission=1.0)
    self.assertEqual(pnl2, 0.0)
    self.assertEqual(port.positions["AAPL"], 20)
    self.assertAlmostEqual(port.cost_basis["AAPL"], 105.0, delta=1e-6)

    # Sell 15 @ 120 (Realized PnL: 15 * (120 - 105) - 2.0 = 225 - 2 = 223)
    pnl3 = port.process_fill("AAPL", 15, "SELL", 120.0, commission=2.0)
    self.assertAlmostEqual(pnl3, 223.0, delta=1e-6)
    self.assertEqual(port.positions["AAPL"], 5)
    self.assertAlmostEqual(port.cost_basis["AAPL"], 105.0, delta=1e-6)
    self.assertAlmostEqual(port.realized_pnl, 223.0, delta=1e-6)

  def test_short_selling_and_covering(self):
    port = SubPortfolio(initial_cash=10000.0)

    # Short 10 @ 100
    pnl1 = port.process_fill("TSLA", 10, "SELL", 100.0, commission=1.0)
    self.assertEqual(pnl1, 0.0)
    self.assertEqual(port.positions["TSLA"], -10)
    self.assertAlmostEqual(port.cost_basis["TSLA"], 100.0, delta=1e-6)
    self.assertAlmostEqual(port.cash, 10000.0 + 999.0, delta=1e-6)

    # Cover 10 @ 80 (Realized PnL: 10 * (100 - 80) - 1.0 = 200 - 1 = 199)
    pnl2 = port.process_fill("TSLA", 10, "BUY", 80.0, commission=1.0)
    self.assertAlmostEqual(pnl2, 199.0, delta=1e-6)
    self.assertNotIn("TSLA", port.positions)
    self.assertAlmostEqual(port.realized_pnl, 199.0, delta=1e-6)

  def test_flip_position_long_to_short(self):
    port = SubPortfolio(initial_cash=10000.0)
    port.process_fill("GOOG", 10, "BUY", 100.0, commission=0.0)
    self.assertEqual(port.positions["GOOG"], 10)

    # Sell 15 @ 110 (Closes 10 long with PnL +100, opens 5 short @ 110)
    pnl = port.process_fill("GOOG", 15, "SELL", 110.0, commission=0.0)
    self.assertAlmostEqual(pnl, 100.0, delta=1e-6)
    self.assertEqual(port.positions["GOOG"], -5)
    self.assertAlmostEqual(port.cost_basis["GOOG"], 110.0, delta=1e-6)

  def test_leverage_and_exposure(self):
    port = SubPortfolio(initial_cash=10000.0)
    port.process_fill("AAPL", 50, "BUY", 100.0, commission=0.0)
    port.process_fill("MSFT", 50, "SELL", 100.0, commission=0.0)

    # Gross exposure = 50 * 100 + 50 * 100 = 10000
    self.assertAlmostEqual(port.get_gross_exposure(), 10000.0, delta=1e-6)
    self.assertAlmostEqual(port.get_nav(), 10000.0, delta=1e-6)
    self.assertAlmostEqual(port.get_leverage(), 1.0, delta=1e-6)


class TestAnalytics(unittest.TestCase):
  """Tests for PerformanceAnalytics, CFA metrics, and monthly heatmaps."""

  def test_drawdown_calculation_with_recovery(self):
    timestamps = [1000, 2000, 3000, 4000, 5000]
    navs = [100.0, 120.0, 90.0, 110.0, 130.0]
    # Peak = 120 (ts 2000), Trough = 90 (ts 3000, DD = (120-90)/120 = 25%), Recovery = 130 (ts 5000)
    dd_details = PerformanceAnalytics.compute_drawdown_details(timestamps, navs)
    self.assertAlmostEqual(dd_details["max_drawdown"], 0.25, delta=1e-6)
    self.assertEqual(dd_details["peak_ts"], 2000)
    self.assertEqual(dd_details["trough_ts"], 3000)
    self.assertEqual(dd_details["recovery_ts"], 5000)
    self.assertEqual(dd_details["max_duration_bars"], 2)

  def test_monthly_returns_matrix(self):
    # Construct 12 months in 2023 with growing NAV
    timestamps = []
    navs = []
    curr_nav = 100.0
    for mo in range(1, 13):
      # Approximate 1st day of month at 00:00:00 UTC in ms
      dt = datetime.datetime(2023, mo, 1, 0, 0, 0, tzinfo=datetime.timezone.utc)
      ts = int(dt.timestamp() * 1000)
      curr_nav *= 1.02  # +2% per month
      timestamps.append(ts)
      navs.append(curr_nav)

    matrix = PerformanceAnalytics.compute_monthly_returns_matrix(timestamps, navs)
    self.assertIn(2023, matrix)
    self.assertIn("annual", matrix[2023])
    self.assertGreater(matrix[2023]["annual"], 20.0)

  def test_trade_statistics_and_streaks(self):
    trades = [
        TradeRecord(1000, "1", "AAPL", "SELL", 10, 100, 110, 0, 0, 100.0, 10100, 0),
        TradeRecord(2000, "2", "AAPL", "SELL", 10, 100, 120, 0, 0, 200.0, 10300, 0),
        TradeRecord(3000, "3", "AAPL", "BUY", 10, 100, 110, 0, 0, -100.0, 10200, 0),
    ]
    stats = PerformanceAnalytics.compute_trade_statistics(trades)
    self.assertEqual(stats["total_trades"], 3)
    self.assertEqual(stats["winning_trades"], 2)
    self.assertEqual(stats["losing_trades"], 1)
    self.assertAlmostEqual(stats["win_rate_pct"], 66.666666, delta=1e-2)
    # Profit factor: 300 / 100 = 3.0
    self.assertAlmostEqual(stats["profit_factor"], 3.0, delta=1e-6)
    self.assertEqual(stats["max_consecutive_wins"], 2)
    self.assertEqual(stats["max_consecutive_losses"], 1)

  def test_benchmark_metrics(self):
    nav_history = [100.0, 102.0, 104.0, 103.0, 106.0]
    bench_nav = [100.0, 101.0, 102.0, 101.5, 103.0]
    timestamps = [1000, 2000, 3000, 4000, 5000]

    report = PerformanceAnalytics.generate_report(
        nav_history=nav_history,
        initial_capital=100.0,
        timestamps=timestamps,
        benchmark_nav=bench_nav,
    )
    self.assertIsNotNone(report.beta)
    self.assertIsNotNone(report.alpha)
    self.assertIsNotNone(report.information_ratio)
    self.assertTrue(math.isfinite(report.sharpe_ratio))
    self.assertTrue(math.isfinite(report.sortino_ratio))
    self.assertTrue(math.isfinite(report.calmar_ratio))


class TestBacktestDriver(unittest.TestCase):
  """Tests for BacktestDriver execution, limit orders, models, and sessions."""

  def setUp(self):
    self.temp_dir = tempfile.TemporaryDirectory()
    self.parquet_path = os.path.join(self.temp_dir.name, "test_market_data.parquet")

    # Define mock bar data for AAPL and MSFT
    data = {
        "symbol": ["AAPL", "MSFT", "AAPL", "MSFT", "AAPL", "MSFT", "AAPL", "MSFT", "AAPL", "MSFT"],
        "timestamp": [
            1783900800000, 1783900800000,
            1783900860000, 1783900860000,
            1783900920000, 1783900920000,
            1783900980000, 1783900980000,
            1783910400000, 1783910400000,
        ],
        "open": [150.0, 250.0, 151.0, 251.0, 152.0, 252.0, 153.0, 253.0, 154.0, 254.0],
        "high": [151.0, 251.0, 152.0, 252.0, 153.0, 253.0, 154.0, 254.0, 155.0, 255.0],
        "low": [149.0, 249.0, 150.0, 250.0, 151.0, 251.0, 152.0, 252.0, 153.0, 253.0],
        "close": [150.5, 250.5, 151.5, 251.5, 152.5, 252.5, 153.5, 253.5, 154.5, 254.5],
        "volume": [10000.0, 20000.0, 11000.0, 21000.0, 12000.0, 22000.0, 13000.0, 23000.0, 14000.0, 24000.0],
    }
    df = pl.DataFrame(data)
    df.write_parquet(self.parquet_path)

  def tearDown(self):
    self.temp_dir.cleanup()

  def test_triple_run_determinism(self):
    """Verifies backtest determinism within 1e-9 tolerance."""
    res1 = run_backtest_session(self.parquet_path, DummyTrendStrategy, initial_capital=100000.0)
    res2 = run_backtest_session(self.parquet_path, DummyTrendStrategy, initial_capital=100000.0)
    res3 = run_backtest_session(self.parquet_path, DummyTrendStrategy, initial_capital=100000.0)

    for key in ["sharpe_ratio", "sortino_ratio", "max_drawdown", "final_pnl", "total_return_pct"]:
      self.assertLessEqual(abs(res1[key] - res2[key]), 1e-9, f"Mismatch in {key}")
      self.assertLessEqual(abs(res2[key] - res3[key]), 1e-9, f"Mismatch in {key}")

  def test_limit_order_execution_logic(self):
    """Verifies LIMIT order matching logic against bar Low and High."""
    ctx = BacktestContext(initial_capital=100000.0)

    # Submit BUY limit @ 149.5 (Bar Low = 149.0 -> should FILL)
    ctx.set_mock_time(1000)
    ctx.submit_order("AAPL", 100, "BUY", price=149.5, order_type="LIMIT")
    # Submit SELL limit @ 155.0 (Bar High = 151.0 -> should NOT FILL)
    ctx.submit_order("AAPL", 50, "SELL", price=155.0, order_type="LIMIT")

    bar = BarDict(open=150.0, high=151.0, low=149.0, close=150.5, volume=10000.0)
    ctx.process_fills_for_bar("AAPL", bar)

    # Buy limit filled, Sell limit still pending
    self.assertEqual(len(ctx.pending_orders), 1)
    self.assertEqual(ctx.pending_orders[0]["side"], "SELL")
    self.assertEqual(len(ctx.trade_history), 1)
    self.assertEqual(ctx.trade_history[0].side, "BUY")

  def test_run_with_market_data_manager(self):
    """Verifies backtest execution directly using MarketDataManager storage."""
    dm = MarketDataManager(data_root=self.temp_dir.name)
    df = pl.read_parquet(self.parquet_path)
    dm.save_bars(df)

    res = run_backtest_session(dm, DummyTrendStrategy, initial_capital=100000.0)
    self.assertIn("final_pnl", res)
    self.assertIn("equity_curve", res)
    self.assertIn("monthly_returns_matrix", res)

  def test_limit_order_sell_execution_and_models(self):
    """Verifies limit sell order matching when high >= limit price and custom models."""
    slip_model = SlippageModel(fixed_bps=5.0, gamma=0.05, alpha=1.0)
    comm_model = CommissionModel(flat_fee=2.0, rate=0.0002, per_share=0.005, min_fee=2.0, max_fee_pct=0.02)
    ctx = BacktestContext(initial_capital=100000.0, slippage_model=slip_model, commission_model=comm_model)

    # First open a long position
    ctx.portfolio.process_fill("AAPL", 100, "BUY", 150.0, commission=2.0)
    self.assertEqual(ctx.get_positions()["AAPL"], 100)
    self.assertAlmostEqual(ctx.get_balance(), 100000.0 - 15002.0, delta=1e-6)

    # Place limit sell order @ 153.0
    ctx.set_mock_time(2000)
    ctx.submit_order("AAPL", 100, "SELL", price=153.0, order_type="LIMIT")

    # Bar where High reaches 154.0
    bar = BarDict(open=151.0, high=154.0, low=150.5, close=153.5, volume=20000.0)
    ctx.process_fills_for_bar("AAPL", bar)

    self.assertEqual(len(ctx.pending_orders), 0)
    self.assertEqual(len(ctx.trade_history), 1)
    trade = ctx.trade_history[0]
    self.assertEqual(trade.side, "SELL")
    self.assertGreater(trade.realized_pnl, 0.0)
    self.assertIn("order_id", trade.to_dict())

    # Risk limits and NAV check
    limits = ctx.get_available_risk_limits()
    self.assertIn("max_leverage", limits)
    self.assertEqual(ctx.now(), 2000)

  def test_bar_dict_attributes_and_errors(self):
    b = BarDict(open=100.0, close=105.0)
    self.assertEqual(b.open, 100.0)
    b.custom_val = 42
    self.assertEqual(b["custom_val"], 42)
    with self.assertRaises(AttributeError):
      _ = b.non_existent_field

  def test_process_fills_for_symbol_backward_compat(self):
    ctx = BacktestContext(initial_capital=100000.0)
    ctx.submit_order("AAPL", 50, "BUY")
    ctx.process_fills_for_symbol("AAPL", close_price=150.0, volume=10000.0)
    self.assertEqual(len(ctx.pending_orders), 0)
    self.assertEqual(ctx.get_positions()["AAPL"], 50)

  def test_run_session_with_various_inputs(self):
    # Test with list of paths
    res_list = run_backtest_session([self.parquet_path], DummyTrendStrategy)
    self.assertIn("final_pnl", res_list)

    # Test with LazyFrame
    lazy_df = pl.scan_parquet(self.parquet_path)
    res_lazy = run_backtest_session(lazy_df, DummyTrendStrategy)
    self.assertIn("final_pnl", res_lazy)

    # Test with invalid market data type
    with self.assertRaises(ValueError):
      run_backtest_session(12345, DummyTrendStrategy)

  def test_multi_asset_limit_strategy_run(self):
    res = run_backtest_session(self.parquet_path, MultiAssetLimitStrategy)
    self.assertIn("total_trades", res)
    self.assertIn("equity_curve", res)

  def test_cancellation_and_edge_cases(self):
    ctx = BacktestContext(initial_capital=100000.0)
    order_id = ctx.submit_order("AAPL", 100, "BUY")
    self.assertTrue(ctx.cancel_order(order_id))
    self.assertFalse(ctx.cancel_order(order_id))

    # Empty data session
    empty_df = pl.DataFrame(schema={
        TIMESTAMP_COL: pl.Int64,
        SYMBOL_COL: pl.String,
        OPEN_COL: pl.Float64,
        HIGH_COL: pl.Float64,
        LOW_COL: pl.Float64,
        CLOSE_COL: pl.Float64,
        VOLUME_COL: pl.Float64,
    })
    res_empty = run_backtest_session(empty_df, DummyTrendStrategy)
    self.assertEqual(res_empty["final_pnl"], 0.0)


if __name__ == "__main__":
  unittest.main()

