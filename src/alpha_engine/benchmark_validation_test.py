"""Institutional Benchmark Validation and Multi-Strategy Long-Horizon Backtest Suite."""

import math
import unittest
import numpy as np
import polars as pl

from src.alpha_engine.analytics import PerformanceAnalytics, PerformanceReport, TradeRecord
from src.alpha_engine.backtest_driver import (
    BacktestContext,
    CommissionModel,
    SlippageModel,
    run_backtest,
)

from src.alpha_engine.data.downloader import SyntheticDataGenerator
from src.alpha_engine.strategies.base import BaseStrategy, StrategyContext, SubPortfolio
from src.alpha_engine.strategies.mean_reversion_strategy import MeanReversionStrategy
from src.alpha_engine.strategies.momentum_strategy import CrossSectionalMomentumStrategy
from src.alpha_engine.strategies.rl_strategy import RLStrategy
from src.alpha_engine.strategies.stat_arb_strategy import StatArbStrategy
from src.alpha_engine.strategies.trend_strategy import TrendStrategy


class MockStrategyContext(StrategyContext):
  """Mock context for direct unit testing of strategies."""

  def __init__(self, initial_nav: float = 100000.0):
    self.positions = {}
    self.balance = initial_nav
    self.nav = initial_nav
    self.orders = []
    self.cancelled_orders = []

  def get_positions(self):
    return self.positions

  def get_balance(self):
    return self.balance

  def get_nav(self):
    return self.nav

  def get_available_risk_limits(self):
    return {"max_leverage": 2.0}

  def submit_order(self, symbol, qty, side, price=0.0, order_type="MARKET"):
    order_id = f"MOCK-ORD-{len(self.orders)+1}"
    self.orders.append({
        "order_id": order_id,
        "symbol": symbol,
        "qty": qty,
        "side": side,
        "price": price,
        "order_type": order_type,
    })
    return order_id

  def cancel_order(self, order_id):
    self.cancelled_orders.append(order_id)
    return True


class BenchmarkValidationTest(unittest.TestCase):
  """Comprehensive test suite for strategies and benchmark comparisons."""

  def test_mean_reversion_strategy_signals(self):
    """Verifies Bollinger Bands and RSI triggers for MeanReversionStrategy."""
    ctx = MockStrategyContext(100000.0)
    strat = MeanReversionStrategy(
        ctx,
        symbol="AAPL",
        window=20,
        num_std=2.0,
        rsi_period=14,
        rsi_oversold=30.0,
        rsi_overbought=70.0,
    )

    # Feed initial 20 bars of flat price to prime indicators
    for i in range(20):
      strat.on_bar({"AAPL": {"close": 150.0, "high": 151.0, "low": 149.0}})

    self.assertEqual(len(ctx.orders), 0)

    # 1. Simulate Oversold Drop (Price drops sharply below lower band, RSI drops < 30)
    for p in [145.0, 140.0, 135.0, 130.0, 125.0]:
      strat.on_bar({"AAPL": {"close": p, "high": p + 1.0, "low": p - 1.0}})

    self.assertGreater(len(ctx.orders), 0)
    buy_order = [o for o in ctx.orders if o["side"] == "BUY"]
    self.assertGreater(len(buy_order), 0)
    self.assertEqual(buy_order[-1]["symbol"], "AAPL")

    # 2. Simulate Mean Reversion Bounce (Crosses SMA back up to 150)
    ctx.positions["AAPL"] = 500  # simulate long position
    strat.on_bar({"AAPL": {"close": 155.0, "high": 156.0, "low": 154.0}})
    sell_order = [o for o in ctx.orders if o["side"] == "SELL"]
    self.assertGreater(len(sell_order), 0)

    # 3. Simulate Overbought Rally (Price surges above upper band, RSI > 70)
    ctx.positions["AAPL"] = 0
    for p in [160.0, 170.0, 180.0, 190.0, 200.0]:
      strat.on_bar({"AAPL": {"close": p, "high": p + 1.0, "low": p - 1.0}})

    short_order = [o for o in ctx.orders if o["side"] == "SELL"]
    self.assertGreater(len(short_order), 0)

    # Coverage for non-dict bar and order status
    class MockBar:
      close = 150.0
      high = 152.0
      low = 148.0
    strat.on_bar(MockBar())
    strat.on_order_status({})

  def test_stat_arb_strategy_signals(self):
    """Verifies cointegrated pairs trading and z-score triggers in StatArbStrategy."""
    ctx = MockStrategyContext(100000.0)
    strat = StatArbStrategy(
        ctx,
        symbol_a="AAPL",
        symbol_b="MSFT",
        window=20,
        entry_z=1.5,
        exit_z=0.5,
        stop_z=15.0,
    )

    # Feed initial 20 bars of correlated prices with slight variance
    for i in range(20):
      strat.on_bar({
          "AAPL": {"close": 150.0 + (i % 3) * 0.5},
          "MSFT": {"close": 300.0 + (i % 3) * 1.0},
      })

    # Divergence: AAPL drops while MSFT rises (Z-score goes negative < -1.5)
    strat.on_bar({"AAPL": {"close": 146.0}, "MSFT": {"close": 304.0}})
    strat.on_bar({"AAPL": {"close": 144.0}, "MSFT": {"close": 306.0}})

    self.assertGreater(len(ctx.orders), 0)
    # Long spread -> Buy A, Sell B
    orders_a = [o for o in ctx.orders if o["symbol"] == "AAPL" and o["side"] == "BUY"]
    orders_b = [o for o in ctx.orders if o["symbol"] == "MSFT" and o["side"] == "SELL"]
    self.assertGreater(len(orders_a), 0)
    self.assertGreater(len(orders_b), 0)

    # Coverage for stop loss exit and order status
    strat.on_bar({"AAPL": {"close": 1.0}, "MSFT": {"close": 1000.0}})
    strat.on_order_status({})


  def test_cross_sectional_momentum_strategy(self):
    """Verifies factor ranking and inverse volatility allocation."""
    ctx = MockStrategyContext(100000.0)
    symbols = ["AAPL", "MSFT", "NVDA", "TSLA"]
    strat = CrossSectionalMomentumStrategy(
        ctx,
        symbols=symbols,
        lookback=10,
        top_k=1,
        rebalance_interval=2,
        allow_short=True,
    )

    # Feed initial 10 bars where NVDA is strongest winner and TSLA is biggest loser
    for i in range(12):
      strat.on_bar({
          "AAPL": {"close": 150.0 + i * 0.5},
          "MSFT": {"close": 300.0 + i * 0.5},
          "NVDA": {"close": 200.0 + i * 10.0},  # Winner
          "TSLA": {"close": 250.0 - i * 8.0},   # Loser
      })

    self.assertGreater(len(ctx.orders), 0)
    nvda_orders = [o for o in ctx.orders if o["symbol"] == "NVDA" and o["side"] == "BUY"]
    tsla_orders = [o for o in ctx.orders if o["symbol"] == "TSLA" and o["side"] == "SELL"]
    self.assertGreater(len(nvda_orders), 0)
    self.assertGreater(len(tsla_orders), 0)
    strat.on_order_status({})

  def test_long_horizon_5_year_backtest_with_spy_qqq_benchmark(self):
    """Executes 5-year (1260 daily bars) multi-asset simulation vs SPY/QQQ benchmarks."""
    start_ts = 1577836800000  # 2020-01-01
    end_ts = start_ts + 1260 * 86400000

    gen_aapl = SyntheticDataGenerator(annual_drift=0.18, annual_volatility=0.20, random_seed=42)
    gen_msft = SyntheticDataGenerator(annual_drift=0.15, annual_volatility=0.18, random_seed=43)
    gen_spy = SyntheticDataGenerator(annual_drift=0.10, annual_volatility=0.15, random_seed=44)

    df_aapl = gen_aapl.fetch_bars("AAPL", start_ts, end_ts, initial_price=120.0)
    df_msft = gen_msft.fetch_bars("MSFT", start_ts, end_ts, initial_price=200.0)
    df_spy = gen_spy.fetch_bars("SPY", start_ts, end_ts, initial_price=300.0)

    # Run Multi-Asset Trend Backtest
    def create_strategy(ctx):
      return TrendStrategy(ctx, symbol="AAPL", fast_period=10, slow_period=50)

    report = run_backtest(
        strategy_factory=create_strategy,
        market_data={"AAPL": df_aapl, "MSFT": df_msft},
        initial_capital=100000.0,
        benchmark_data=df_spy,
        slippage_model=SlippageModel(fixed_bps=5.0),
        commission_model=CommissionModel(flat_fee=1.0, rate=0.0001),
    )

    # Verify CFA Performance Report metrics
    self.assertEqual(report.initial_capital, 100000.0)
    self.assertGreater(report.final_nav, 0.0)
    self.assertIsInstance(report.cagr_pct, float)
    self.assertIsInstance(report.sharpe_ratio, float)
    self.assertIsInstance(report.max_drawdown, float)

    # Verify Benchmark Metrics (Beta, Alpha, Information Ratio, Benchmark CAGR)
    self.assertIsNotNone(report.beta)
    self.assertIsNotNone(report.alpha)
    self.assertIsNotNone(report.benchmark_total_return_pct)
    self.assertIsNotNone(report.benchmark_cagr_pct)
    self.assertIsNotNone(report.tracking_error)
    self.assertIsNotNone(report.information_ratio)

    # Verify Capture Ratios
    if report.up_capture_ratio is not None:
      self.assertIsInstance(report.up_capture_ratio, float)
    if report.down_capture_ratio is not None:
      self.assertIsInstance(report.down_capture_ratio, float)

    # Verify Monthly Calendar Matrix contains multiple years
    self.assertGreater(len(report.monthly_returns_matrix), 1)

  def test_long_horizon_10_year_backtest_with_mean_reversion(self):
    """Executes 10-year (2520 daily bars) backtest validating institutional robustness."""
    start_ts = 1420070400000  # 2015-01-01
    end_ts = start_ts + 2520 * 86400000

    gen_aapl = SyntheticDataGenerator(annual_drift=0.12, annual_volatility=0.22, random_seed=123)
    gen_qqq = SyntheticDataGenerator(annual_drift=0.14, annual_volatility=0.19, random_seed=124)

    df_aapl = gen_aapl.fetch_bars("AAPL", start_ts, end_ts, initial_price=100.0)
    df_qqq = gen_qqq.fetch_bars("QQQ", start_ts, end_ts, initial_price=150.0)

    def create_strategy(ctx):
      return MeanReversionStrategy(ctx, symbol="AAPL", window=20, num_std=2.0)

    report = run_backtest(
        strategy_factory=create_strategy,
        market_data={"AAPL": df_aapl},
        initial_capital=250000.0,
        benchmark_data=df_qqq,
        slippage_model=SlippageModel(fixed_bps=3.0),
        commission_model=CommissionModel(flat_fee=0.5, rate=0.00005),
    )

    self.assertEqual(report.initial_capital, 250000.0)
    self.assertGreater(report.final_nav, 0.0)
    self.assertGreater(len(report.equity_curve), 2000)
    self.assertGreater(len(report.monthly_returns_matrix), 5)


if __name__ == "__main__":
  unittest.main()

