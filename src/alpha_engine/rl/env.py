import gymnasium as gym
from gymnasium import spaces
import numpy as np
from typing import Dict, Any, Tuple, List
from src.alpha_engine.strategies.base import SubPortfolio

class TradingGymEnv(gym.Env):
    metadata = {"render_modes": ["human"]}

    def __init__(self,
                 features_df: Any = None,
                 initial_cash: float = 100000.0,
                 max_position: int = 1000,
                 slippage_gamma: float = 0.1,
                 commission_rate: float = 0.0001,
                 turnover_penalty: float = 0.001,
                 window_size: int = 20,
                 symbol: str = "AAPL"):
        super(TradingGymEnv, self).__init__()
        
        self.symbol = symbol
        self.initial_cash = initial_cash
        self.max_position = max_position
        self.slippage_gamma = slippage_gamma
        self.commission_rate = commission_rate
        self.turnover_penalty = turnover_penalty
        self.window_size = window_size
        self.features_df = features_df
        
        # Action space: target portfolio weight [-1.0, 1.0]
        self.action_space = spaces.Box(low=-1.0, high=1.0, shape=(1,), dtype=np.float32)
        
        # Observation space:
        # [log_return, rolling_mean, rolling_std, rolling_zscore, norm_pos, norm_cash]
        self.observation_space = spaces.Box(low=-np.inf, high=np.inf, shape=(6,), dtype=np.float32)
        
        self.portfolio = SubPortfolio(self.initial_cash)
        self.current_idx = self.window_size
        self.pending_orders: List[Tuple[int, str]] = []
        self.last_nav = self.initial_cash

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        
        self.portfolio = SubPortfolio(self.initial_cash)
        self.current_idx = self.window_size
        self.pending_orders.clear()
        
        if self.features_df is not None and len(self.features_df) > self.current_idx:
            row = self.features_df.row(self.current_idx, named=True)
            self.portfolio.update_price(self.symbol, row['close'])
            
        self.last_nav = self.portfolio.get_nav()
        
        obs = self._get_observation()
        info = self._get_info()
        return obs, info

    def _get_observation(self) -> np.ndarray:
        if self.features_df is None or len(self.features_df) <= self.current_idx:
            return np.zeros(6, dtype=np.float32)
            
        row = self.features_df.row(self.current_idx, named=True)
        
        log_return = float(row.get("log_return", 0.0))
        rolling_mean = float(row.get("rolling_mean_log_return", 0.0))
        rolling_std = float(row.get("rolling_std_log_return", 1e-8))
        rolling_zscore = float(row.get("rolling_zscore_close", 0.0))
        
        pos = self.portfolio.positions.get(self.symbol, 0)
        norm_pos = float(pos / self.max_position)
        
        nav = self.portfolio.get_nav()
        norm_cash = float(self.portfolio.cash / nav if nav > 0 else 1.0)
        
        return np.array([log_return, rolling_mean, rolling_std, rolling_zscore, norm_pos, norm_cash], dtype=np.float32)

    def _get_info(self) -> Dict[str, Any]:
        nav = self.portfolio.get_nav()
        pos = self.portfolio.positions.get(self.symbol, 0)
        
        # Bounds mask: Continuous action space bounds
        max_long_weight = 1.0
        max_short_weight = -1.0
        
        return {
            "nav": nav,
            "position": pos,
            "cash": self.portfolio.cash,
            "action_mask": [max_short_weight, max_long_weight]
        }

    def step(self, action: np.ndarray) -> Tuple[np.ndarray, float, bool, bool, Dict[str, Any]]:
        target_weight = float(np.clip(action[0], -1.0, 1.0))
        
        # 1. Process pending orders from previous steps using current bar price
        if self.features_df is None or len(self.features_df) <= self.current_idx:
            return self._get_observation(), 0.0, True, False, self._get_info()
            
        row = self.features_df.row(self.current_idx, named=True)
        price_base = float(row['close'])
        volume = float(row.get('volume', 100000.0))
        
        executed_turnover = 0.0
        total_commission = 0.0
        
        # Execute pending orders
        for qty, side in self.pending_orders:
            # Slippage calculation
            if volume > 0:
                slippage_pct = self.slippage_gamma * (qty / volume)
            else:
                slippage_pct = 0.0
                
            if side.upper() == 'BUY':
                exec_price = price_base * (1.0 + slippage_pct)
            else:
                exec_price = price_base * (1.0 - slippage_pct)
                
            commission = qty * exec_price * self.commission_rate
            self.portfolio.process_fill(self.symbol, qty, side, exec_price, commission)
            
            executed_turnover += qty * exec_price
            total_commission += commission
            
        self.pending_orders.clear()
        
        # Update current price in portfolio for final NAV calculation
        self.portfolio.update_price(self.symbol, price_base)
        current_nav = self.portfolio.get_nav()
        
        # 2. Reward calculation (Normalized Log Reward + Commission/Turnover Penalties)
        log_return_nav = float(np.log(current_nav / self.last_nav)) if self.last_nav > 0 and current_nav > 0 else 0.0
        turnover_penalty_val = self.turnover_penalty * (executed_turnover / current_nav) if current_nav > 0 else 0.0
        commission_penalty = total_commission / current_nav if current_nav > 0 else 0.0
        
        reward = log_return_nav - turnover_penalty_val - commission_penalty
        
        self.last_nav = current_nav
        
        # 3. Create next pending order based on weight action
        target_qty = int(round(target_weight * current_nav / price_base))
        target_qty = int(np.clip(target_qty, -self.max_position, self.max_position))
        
        current_qty = self.portfolio.positions.get(self.symbol, 0)
        order_qty = target_qty - current_qty
        
        if order_qty != 0:
            side = 'BUY' if order_qty > 0 else 'SELL'
            self.pending_orders.append((abs(order_qty), side))
            
        self.current_idx += 1
        
        terminated = False
        truncated = False
        
        if self.current_idx >= len(self.features_df) - 1:
            terminated = True
            
        if current_nav <= self.initial_cash * 0.1:
            terminated = True
            
        obs = self._get_observation()
        info = self._get_info()
        
        return obs, reward, terminated, truncated, info
