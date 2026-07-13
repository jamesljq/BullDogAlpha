from typing import Any
from src.alpha_engine.strategies.base import BaseStrategy, StrategyContext
from collections import deque

class TrendStrategy(BaseStrategy):
    def __init__(self, ctx: StrategyContext, symbol: str, fast_period: int = 5, slow_period: int = 20):
        super().__init__(ctx)
        self.symbol = symbol
        self.fast_period = fast_period
        self.slow_period = slow_period
        self.prices = deque(maxlen=slow_period)

    def on_bar(self, bar: Any) -> None:
        close = float(bar[self.symbol]['close'])
        self.prices.append(close)
        
        if len(self.prices) < self.slow_period:
            return
            
        fast_sma = sum(list(self.prices)[-self.fast_period:]) / self.fast_period
        slow_sma = sum(list(self.prices)) / self.slow_period
        
        current_positions = self.ctx.get_positions()
        current_qty = current_positions.get(self.symbol, 0)
        
        nav = self.ctx.get_nav()
        
        if fast_sma > slow_sma:
            target_weight = 1.0
        else:
            target_weight = -1.0
            
        target_qty = int(round(target_weight * nav / close))
        order_qty = target_qty - current_qty
        
        if order_qty > 0:
            self.ctx.submit_order(self.symbol, abs(order_qty), "BUY", close)
        elif order_qty < 0:
            self.ctx.submit_order(self.symbol, abs(order_qty), "SELL", close)

    def on_order_status(self, order_response: Any) -> None:
        pass
