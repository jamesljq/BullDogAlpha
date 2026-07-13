import os
from typing import Any, Optional
import numpy as np
from src.alpha_engine.strategies.base import BaseStrategy, StrategyContext
from src.alpha_engine.rl.features import FeatureExtractor, ActionAdapter

class RLStrategy(BaseStrategy):
    def __init__(self,
                 ctx: StrategyContext,
                 symbol: str,
                 model_path: Optional[str] = None,
                 window_size: int = 20,
                 max_position: int = 1000,
                 vol_target: Optional[float] = None,
                 min_qty: int = 5,
                 min_value: float = 100.0):
        super().__init__(ctx)
        self.symbol = symbol
        self.max_position = max_position
        self.feature_extractor = FeatureExtractor(window_size=window_size)
        self.action_adapter = ActionAdapter(
            symbol=symbol,
            min_qty=min_qty,
            min_value=min_value,
            vol_target=vol_target,
            vol_window=window_size
        )
        
        self.ort_session = None
        if model_path and os.path.exists(model_path):
            import onnxruntime as ort
            self.ort_session = ort.InferenceSession(model_path)
            
    def on_bar(self, bar: Any) -> None:
        symbol_bar = bar[self.symbol]
        close = float(symbol_bar['close'])
        features = self.feature_extractor.push(self.symbol, symbol_bar)
        
        if len(self.feature_extractor.windows.get(self.symbol, [])) < self.feature_extractor.window_size + 1:
            return
            
        log_return = features["log_return"]
        rolling_mean = features["rolling_mean_log_return"]
        rolling_std = features["rolling_std_log_return"]
        rolling_zscore = features["rolling_zscore_close"]
        
        current_positions = self.ctx.get_positions()
        current_qty = current_positions.get(self.symbol, 0)
        norm_pos = current_qty / self.max_position
        
        nav = self.ctx.get_nav()
        balance = self.ctx.get_balance()
        norm_cash = balance / nav if nav > 0 else 1.0
        
        obs = np.array([[log_return, rolling_mean, rolling_std, rolling_zscore, norm_pos, norm_cash]], dtype=np.float32)
        
        if self.ort_session is not None:
            input_name = self.ort_session.get_inputs()[0].name
            ort_outs = self.ort_session.run(None, {input_name: obs})
            target_weight = float(ort_outs[0][0][0])
        else:
            if rolling_zscore > 1.0:
                target_weight = 0.5
            elif rolling_zscore < -1.0:
                target_weight = -0.5
            else:
                target_weight = 0.0
                
        order_qty = self.action_adapter.adapt_action(target_weight, current_qty, close, nav)
        
        if order_qty > 0:
            self.ctx.submit_order(self.symbol, abs(order_qty), "BUY", close)
        elif order_qty < 0:
            self.ctx.submit_order(self.symbol, abs(order_qty), "SELL", close)

    def on_order_status(self, order_response: Any) -> None:
        pass
