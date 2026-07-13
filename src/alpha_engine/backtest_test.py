import os
import unittest
import tempfile
import math
import polars as pl
from src.alpha_engine.strategies.base import BaseStrategy
from src.alpha_engine.backtest_driver import run_backtest_session, BacktestContext, BarDict, compute_performance_metrics

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
            self.ctx.submit_order(self.symbol, 100, "BUY")
            self.buy_done = True
        elif close > 153.0 and not self.sell_done:
            self.ctx.submit_order(self.symbol, 50, "SELL")
            self.sell_done = True

    def on_order_status(self, order_response) -> None:
        pass

class TestBacktestDriver(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.parquet_path = os.path.join(self.temp_dir.name, "test_market_data.parquet")

        # Define 10 rows of mock bar data for two symbols (AAPL and MSFT)
        data = {
            "symbol": ["AAPL", "MSFT", "AAPL", "MSFT", "AAPL", "MSFT", "AAPL", "MSFT", "AAPL", "MSFT"],
            "timestamp": [1783900800000, 1783900800000, 1783900860000, 1783900860000, 1783900920000, 1783900920000, 1783900980000, 1783900980000, 1783910400000, 1783910400000],
            "open": [150.0, 250.0, 151.0, 251.0, 152.0, 252.0, 153.0, 253.0, 154.0, 254.0],
            "high": [151.0, 251.0, 152.0, 252.0, 153.0, 253.0, 154.0, 254.0, 155.0, 255.0],
            "low": [149.0, 249.0, 150.0, 250.0, 151.0, 251.0, 152.0, 252.0, 153.0, 253.0],
            "close": [150.5, 250.5, 151.5, 251.5, 152.5, 252.5, 153.5, 253.5, 154.5, 254.5],
            "volume": [10000.0, 20000.0, 11000.0, 21000.0, 12000.0, 22000.0, 13000.0, 23000.0, 14000.0, 24000.0]
        }
        df = pl.DataFrame(data)
        df.write_parquet(self.parquet_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_triple_run_determinism(self):
        """Verifies that running backtests multiple times yields identical float metrics within 1e-9 tolerance."""
        res1 = run_backtest_session(self.parquet_path, DummyTrendStrategy, initial_capital=100000.0)
        res2 = run_backtest_session(self.parquet_path, DummyTrendStrategy, initial_capital=100000.0)
        res3 = run_backtest_session(self.parquet_path, DummyTrendStrategy, initial_capital=100000.0)

        for key in ["sharpe_ratio", "sortino_ratio", "max_drawdown", "final_pnl"]:
            self.assertLessEqual(abs(res1[key] - res2[key]), 1e-9, f"Mismatch in {key} between Run 1 and Run 2")
            self.assertLessEqual(abs(res2[key] - res3[key]), 1e-9, f"Mismatch in {key} between Run 2 and Run 3")

    def test_slippage_and_fee_modeling(self):
        """Verifies microstructure slippage and broker commissions are computed correctly during execution fills."""
        # We run manually using a custom BacktestContext
        ctx = BacktestContext(initial_capital=100000.0, slippage_gamma=0.1, commission_rate=0.0001, flat_fee=1.0)
        
        # T = 1000: Place order
        ctx.set_mock_time(1000)
        self.assertEqual(ctx.now(), 1000)
        ctx.submit_order("AAPL", 100, "BUY")
        self.assertEqual(len(ctx.pending_orders), 1)

        # T = 2000: Process fills with close = 151.5 and volume = 11000
        # Expected execution price: 151.5 * (1 + 0.1 * 100 / 11000)
        # = 151.5 * (1 + 0.0009090909090909091) = 151.5 * 1.0009090909090908 = 151.63772727272727
        # Expected commission: 100 * 151.63772727272727 * 0.0001 + 1.0 = 1.5163772727272727 + 1.0 = 2.5163772727272727
        close_price = 151.5
        volume = 11000.0
        ctx.process_fills_for_symbol("AAPL", close_price, volume)

        self.assertEqual(len(ctx.pending_orders), 0)
        filled_order = ctx.orders[list(ctx.orders.keys())[0]]
        self.assertEqual(filled_order["status"], "FILLED")
        self.assertAlmostEqual(filled_order["exec_price"], 151.63772727272727, delta=1e-9)
        self.assertAlmostEqual(filled_order["commission"], 2.5163772727272727, delta=1e-9)

        # Verification of portfolio state updates
        expected_cash = 100000.0 - (100 * filled_order["exec_price"] + filled_order["commission"])
        self.assertAlmostEqual(ctx.get_balance(), expected_cash, delta=1e-9)
        self.assertEqual(ctx.get_positions()["AAPL"], 100)

    def test_order_cancellation(self):
        """Verifies order cancellation behaves correctly in BacktestContext."""
        ctx = BacktestContext(initial_capital=100000.0)
        order_id = ctx.submit_order("AAPL", 100, "BUY")
        self.assertEqual(len(ctx.pending_orders), 1)

        # Cancel order
        success = ctx.cancel_order(order_id)
        self.assertTrue(success)
        self.assertEqual(len(ctx.pending_orders), 0)
        self.assertEqual(ctx.orders[order_id]["status"], "CANCELLED")

        # Re-cancelling or cancelling invalid ID
        self.assertFalse(ctx.cancel_order(order_id))
        self.assertFalse(ctx.cancel_order("non_existent_id"))


    def test_anti_lookahead_isolation(self):
        """Verifies that the strategy cannot access timestamps ahead of the current event time."""
        class MaliciousStrategy(BaseStrategy):
            def __init__(self, ctx):
                super().__init__(ctx)
                self.observed_times = []

            def on_initialize(self, ctx) -> None:
                pass

            def on_bar(self, bar_dict) -> None:
                # Store the mock time inside strategy
                self.observed_times.append(self.ctx.now())

            def on_order_status(self, order_response) -> None:
                pass
                
        ctx = BacktestContext(initial_capital=100000.0)
        strategy = MaliciousStrategy(ctx)
        
        # Test sequential event simulation
        ctx.set_mock_time(1000)
        strategy.on_bar({"AAPL": BarDict(close=150.0)})
        self.assertEqual(strategy.observed_times[-1], 1000)

        ctx.set_mock_time(2000)
        strategy.on_bar({"AAPL": BarDict(close=151.0)})
        self.assertEqual(strategy.observed_times[-1], 2000)
        
        # Verify previous records did not have access to future state
        self.assertEqual(strategy.observed_times, [1000, 2000])

    def test_metrics_calculation(self):
        """Verifies statistical metric calculations for Sharpe, Sortino, P&L and Max Drawdown."""
        nav_history = [100000.0, 101000.0, 100500.0, 102000.0]
        initial_capital = 100000.0
        
        metrics = compute_performance_metrics(nav_history, initial_capital)
        self.assertAlmostEqual(metrics["final_pnl"], 2000.0, delta=1e-9)
        
        # Max Drawdown should be from Peak 101000 to Trough 100500
        # Peak = 101000, Trough = 100500, Drawdown = (101000 - 100500) / 101000 = 500 / 101000 = 0.00495049504950495
        self.assertAlmostEqual(metrics["max_drawdown"], 0.00495049504950495, delta=1e-9)

        # Basic verification that Sharpe and Sortino are computed and finite
        self.assertTrue(math.isfinite(metrics["sharpe_ratio"]))
        self.assertTrue(math.isfinite(metrics["sortino_ratio"]))

    def test_bar_dict_attributes(self):
        """Verifies BarDict supports both dictionary-like and attribute-like access."""
        b = BarDict(open=100.0, close=105.0)
        self.assertEqual(b.open, 100.0)
        self.assertEqual(b["close"], 105.0)

        # Attribute assignment
        b.high = 110.0
        self.assertEqual(b["high"], 110.0)

        # Attribute error
        with self.assertRaises(AttributeError):
            _ = b.non_existent

if __name__ == "__main__":
    unittest.main()
