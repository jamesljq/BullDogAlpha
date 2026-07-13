import numpy as np
import polars as pl
from collections import deque
from typing import Dict, Any, List

class FeatureExtractor:
    def __init__(self, window_size: int = 20, eps: float = 1e-8):
        self.window_size = window_size
        self.eps = eps
        # Keep window_size + 1 close prices to compute window_size log returns
        self.windows: Dict[str, deque] = {}

    def push(self, symbol: str, bar: Dict[str, Any]) -> Dict[str, float]:
        """Pushes a new bar (requires 'close') and returns features."""
        close = float(bar['close'])
        if symbol not in self.windows:
            self.windows[symbol] = deque(maxlen=self.window_size + 1)
        
        self.windows[symbol].append(close)
        
        closes = list(self.windows[symbol])
        n = len(closes)
        
        # Calculate features
        log_return = 0.0
        rolling_mean_log_return = 0.0
        rolling_std_log_return = 0.0
        rolling_zscore_close = 0.0
        
        if n >= 2:
            log_return = float(np.log(closes[-1] / closes[-2]))
            returns = [float(np.log(closes[i] / closes[i-1])) for i in range(1, n)]
            rolling_mean_log_return = float(np.mean(returns))
            rolling_std_log_return = float(np.std(returns)) + self.eps
            
            close_window = closes[-self.window_size:]
            mean_close = float(np.mean(close_window))
            std_close = float(np.std(close_window))
            rolling_zscore_close = float((close - mean_close) / (std_close + self.eps))
            
        return {
            "log_return": log_return,
            "rolling_mean_log_return": rolling_mean_log_return,
            "rolling_std_log_return": rolling_std_log_return,
            "rolling_zscore_close": rolling_zscore_close
        }

    def calculate_batch(self, df: pl.DataFrame) -> pl.DataFrame:
        """Computes the exact same features in batch using Polars for high performance."""
        W = self.window_size
        eps = self.eps
        
        # Ensure we are sorted by symbol and time
        df_sorted = df.sort(["symbol", "time"])
        
        # Define manual rolling variance and std with ddof=0 to avoid version discrepancies
        def rolling_std_ddof0(col_name: str, window: int) -> pl.Expr:
            mean_x2 = pl.col(col_name).pow(2).rolling_mean(window)
            mean_x = pl.col(col_name).rolling_mean(window)
            variance = mean_x2 - mean_x.pow(2)
            # Clip negative values due to float precision
            return variance.clip(0).sqrt()

        res = df_sorted.with_columns([
            pl.col("close").log().diff().over("symbol").alias("log_return")
        ]).with_columns([
            pl.col("log_return").fill_null(0.0).alias("log_return")
        ]).with_columns([
            pl.col("log_return").rolling_mean(W).over("symbol").alias("rolling_mean_log_return"),
            (rolling_std_ddof0("log_return", W).over("symbol") + eps).alias("rolling_std_log_return"),
            ((pl.col("close") - pl.col("close").rolling_mean(W).over("symbol")) / 
             (rolling_std_ddof0("close", W).over("symbol") + eps)).alias("rolling_zscore_close")
        ]).with_columns([
            pl.col("rolling_mean_log_return").fill_null(0.0),
            pl.col("rolling_std_log_return").fill_null(eps),
            pl.col("rolling_zscore_close").fill_null(0.0)
        ])
        
        return res

class ActionAdapter:
    def __init__(self, symbol: str, min_qty: int = 5, min_value: float = 100.0,
                 vol_target: float = None, vol_window: int = 20, eps: float = 1e-8):
        self.symbol = symbol
        self.min_qty = min_qty
        self.min_value = min_value
        self.vol_target = vol_target
        self.vol_window = vol_window
        self.eps = eps
        self.nav_history: deque = deque(maxlen=vol_window + 1)

    def record_nav(self, nav: float):
        self.nav_history.append(nav)

    def get_vol_multiplier(self) -> float:
        if self.vol_target is None or len(self.nav_history) < 3:
            return 1.0
        navs = list(self.nav_history)
        returns = [float(np.log(navs[i] / navs[i-1])) for i in range(1, len(navs))]
        vol = float(np.std(returns))
        if vol <= self.eps:
            return 1.0
        return min(1.0, self.vol_target / vol)

    def adapt_action(self, target_weight: float, current_qty: int, price: float, nav: float) -> int:
        """
        Translates target portfolio weight into integer share order quantity with filters.
        """
        self.record_nav(nav)
        
        # Volatility Targeting Overlay
        mult = self.get_vol_multiplier()
        adjusted_weight = target_weight * mult
        
        if price <= 0:
            return 0
            
        target_shares = int(round(adjusted_weight * nav / price))
        order_qty = target_shares - current_qty
        
        # Apply min filters
        abs_qty = abs(order_qty)
        trade_value = abs_qty * price
        if abs_qty < self.min_qty or trade_value < self.min_value:
            return 0
            
        return order_qty
