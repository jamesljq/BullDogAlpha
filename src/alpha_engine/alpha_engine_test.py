import unittest
import numpy as np
import polars as pl
import gymnasium as gym
from src.alpha_engine.rl.features import FeatureExtractor, ActionAdapter
from src.alpha_engine.rl.env import TradingGymEnv
from src.alpha_engine.strategies.base import StrategyContext, BaseStrategy, SubPortfolio
from src.alpha_engine.strategies.rl_strategy import RLStrategy
from src.alpha_engine.strategies.trend_strategy import TrendStrategy
from src.alpha_engine.engine import BacktestContext, LiveContext, StrategyOrchestrator

class TestAlphaEngine(unittest.TestCase):
    def setUp(self):
        np.random.seed(42)
        prices = 100.0 + np.cumsum(np.random.normal(0, 1.0, 50))
        prices = np.clip(prices, 50.0, 150.0)
        
        data = {
            "symbol": ["AAPL"] * 50,
            "time": list(range(1000, 1050)),
            "open": list(prices - 0.5),
            "high": list(prices + 1.0),
            "low": list(prices - 1.0),
            "close": list(prices),
            "volume": [10000.0 + i * 100 for i in range(50)]
        }
        self.df = pl.DataFrame(data)

    def test_feature_extractor_incremental_vs_batch(self):
        extractor = FeatureExtractor(window_size=10)
        batch_df = extractor.calculate_batch(self.df)
        
        incremental_features = []
        for i in range(len(self.df)):
            row = self.df.row(i, named=True)
            feats = extractor.push("AAPL", row)
            incremental_features.append(feats)
            
        for idx in range(11, 50):
            batch_row = batch_df.row(idx, named=True)
            inc = incremental_features[idx]
            
            self.assertAlmostEqual(batch_row["log_return"], inc["log_return"], delta=1e-9)
            self.assertAlmostEqual(batch_row["rolling_mean_log_return"], inc["rolling_mean_log_return"], delta=1e-9)
            self.assertAlmostEqual(batch_row["rolling_std_log_return"], inc["rolling_std_log_return"], delta=1e-9)
            self.assertAlmostEqual(batch_row["rolling_zscore_close"], inc["rolling_zscore_close"], delta=1e-9)

    def test_feature_extractor_zero_volatility(self):
        extractor = FeatureExtractor(window_size=10, eps=1e-8)
        for i in range(20):
            bar = {"close": 100.0}
            feats = extractor.push("AAPL", bar)
            
        self.assertAlmostEqual(feats["rolling_std_log_return"], 1e-8, delta=1e-12)
        self.assertAlmostEqual(feats["rolling_zscore_close"], 0.0, delta=1e-12)

    def test_trading_gym_env_contract(self):
        extractor = FeatureExtractor(window_size=10)
        features_df = extractor.calculate_batch(self.df)
        
        env = TradingGymEnv(features_df=features_df, window_size=10)
        
        obs, info = env.reset()
        self.assertEqual(obs.shape, (6,))
        self.assertEqual(info["position"], 0)
        self.assertEqual(info["cash"], 100000.0)
        
        obs, reward, terminated, truncated, info = env.step(np.array([0.5], dtype=np.float32))
        self.assertEqual(info["position"], 0)
        self.assertFalse(terminated)
        self.assertFalse(truncated)
        
        obs, reward, terminated, truncated, info = env.step(np.array([0.5], dtype=np.float32))
        self.assertNotEqual(info["position"], 0)

    def test_action_adapter_filters_and_vol_targeting(self):
        adapter = ActionAdapter(symbol="AAPL", min_qty=5, min_value=100.0)
        
        order_qty = adapter.adapt_action(target_weight=0.0001, current_qty=0, price=100.0, nav=100000.0)
        self.assertEqual(order_qty, 0)
        
        order_qty = adapter.adapt_action(target_weight=0.005, current_qty=0, price=100.0, nav=100000.0)
        self.assertEqual(order_qty, 5)
        
        adapter_vol = ActionAdapter(symbol="AAPL", vol_target=0.01, vol_window=5)
        for nav in [10000, 10500, 11025, 11576, 12155, 12762]:
            adapter_vol.record_nav(nav)
            
        order_qty_scaled = adapter_vol.adapt_action(target_weight=1.0, current_qty=0, price=10.0, nav=10000.0)
        self.assertLess(order_qty_scaled, 1000)

    def test_sync_barrier_and_forward_fill(self):
        orchestrator = StrategyOrchestrator()
        ctx = BacktestContext(100000.0)
        
        class MockStrategy(BaseStrategy):
            def __init__(self, ctx):
                super().__init__(ctx)
                self.calls = []
                
            def on_bar(self, bar_dict):
                self.calls.append(bar_dict)
                
            def on_order_status(self, order_response):
                pass
                
        strat = MockStrategy(ctx)
        orchestrator.register_strategy(strat, ["AAPL", "TSLA"], ctx)
        
        orchestrator.on_incoming_bar("AAPL", {"time": 1, "close": 150.0, "volume": 100.0})
        self.assertEqual(len(strat.calls), 0)
        
        orchestrator.on_incoming_bar("TSLA", {"time": 1, "close": 200.0, "volume": 200.0})
        self.assertEqual(len(strat.calls), 1)
        self.assertIn("AAPL", strat.calls[0])
        self.assertIn("TSLA", strat.calls[0])
        
        orchestrator.on_incoming_bar("AAPL", {"time": 2, "close": 152.0, "volume": 110.0})
        orchestrator.on_incoming_bar("AAPL", {"time": 3, "close": 153.0, "volume": 120.0})
        
        self.assertEqual(len(strat.calls), 2)
        t2_bars = strat.calls[1]
        self.assertEqual(t2_bars["TSLA"]["volume"], 0.0)
        self.assertEqual(t2_bars["TSLA"]["close"], 200.0)

    def test_orchestrator_portfolio_isolation(self):
        orchestrator = StrategyOrchestrator()
        ctx_a = BacktestContext(30000.0)
        ctx_b = BacktestContext(70000.0)
        
        class DummyStrategy(BaseStrategy):
            def on_bar(self, bar): pass
            def on_order_status(self, order): pass
            
        strat_a = DummyStrategy(ctx_a)
        strat_b = DummyStrategy(ctx_b)
        
        orchestrator.register_strategy(strat_a, ["AAPL"], ctx_a)
        orchestrator.register_strategy(strat_b, ["AAPL"], ctx_b)
        
        ctx_a.submit_order("AAPL", 100, "BUY", 100.0)
        self.assertEqual(len(ctx_a.pending_orders), 1)
        self.assertEqual(len(ctx_b.pending_orders), 0)
        
        ctx_a.process_pending_orders({"AAPL": 100.0})
        self.assertEqual(ctx_a.portfolio.positions.get("AAPL"), 100)
        self.assertNotIn("AAPL", ctx_b.portfolio.positions)

    def test_trend_strategy_execution(self):
        orchestrator = StrategyOrchestrator()
        ctx = BacktestContext(100000.0)
        strategy = TrendStrategy(ctx, "AAPL", fast_period=2, slow_period=5)
        orchestrator.register_strategy(strategy, ["AAPL"], ctx)
        
        prices = [10.0, 10.0, 10.0, 15.0, 20.0]
        for i, p in enumerate(prices):
            orchestrator.on_incoming_bar("AAPL", {"time": 1000 + i, "close": p, "volume": 10000.0})
            
        self.assertGreater(len(ctx.orders), 0)

    def test_rl_strategy_execution(self):
        orchestrator = StrategyOrchestrator()
        ctx = BacktestContext(100000.0)
        strategy = RLStrategy(ctx, "AAPL", model_path=None, window_size=5)
        orchestrator.register_strategy(strategy, ["AAPL"], ctx)
        
        # Test LiveContext mock paths as well
        live_ctx = LiveContext(100000.0)
        live_ctx.submit_order("AAPL", 10, "BUY", 10.0)
        live_ctx.cancel_order(list(live_ctx.orders.keys())[0])
        self.assertEqual(live_ctx.get_positions(), {})
        self.assertEqual(live_ctx.get_balance(), 100000.0)
        self.assertEqual(live_ctx.get_nav(), 100000.0)
        self.assertIn("max_leverage", live_ctx.get_available_risk_limits())
        
        # Warm up strategy
        prices = [10.0, 11.0, 12.0, 11.0, 10.0, 15.0]
        for i, p in enumerate(prices):
            orchestrator.on_incoming_bar("AAPL", {"time": 1000 + i, "close": p, "volume": 10000.0})
            
        self.assertGreaterEqual(len(strategy.feature_extractor.windows.get("AAPL", [])), 6)

if __name__ == "__main__":
    unittest.main()
