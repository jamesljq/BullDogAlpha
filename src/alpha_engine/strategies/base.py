from abc import ABC, abstractmethod
from typing import Dict, Any

class StrategyContext(ABC):
    @abstractmethod
    def get_positions(self) -> Dict[str, int]:
        """Returns map of symbol to current position."""
        pass

    @abstractmethod
    def get_balance(self) -> float:
        """Returns current available cash balance."""
        pass

    @abstractmethod
    def get_nav(self) -> float:
        """Returns the Net Asset Value of this sub-portfolio."""
        pass

    @abstractmethod
    def get_available_risk_limits(self) -> Dict[str, Any]:
        """Returns risk limit thresholds."""
        pass

    @abstractmethod
    def submit_order(self, symbol: str, qty: int, side: str, price: float = 0.0) -> str:
        """Submits order and returns unique order ID."""
        pass

    @abstractmethod
    def cancel_order(self, order_id: str) -> bool:
        """Cancels a pending order."""
        pass

class BaseStrategy(ABC):
    def __init__(self, ctx: StrategyContext):
        self.ctx = ctx

    @abstractmethod
    def on_bar(self, bar: Any) -> None:
        """Callback invoked when a new synchronized bar or set of bars is received."""
        pass

    @abstractmethod
    def on_order_status(self, order_response: Any) -> None:
        """Callback invoked when order status changes."""
        pass

class SubPortfolio:
    def __init__(self, initial_cash: float):
        self.initial_cash = initial_cash
        self.cash = initial_cash
        self.positions: Dict[str, int] = {}
        self.last_prices: Dict[str, float] = {}

    def update_price(self, symbol: str, price: float):
        self.last_prices[symbol] = price

    def get_nav(self) -> float:
        position_value = sum(qty * self.last_prices.get(symbol, 0.0) for symbol, qty in self.positions.items())
        return self.cash + position_value

    def process_fill(self, symbol: str, qty: int, side: str, exec_price: float, commission: float):
        """Updates cash and positions upon a filled order.
        qty: positive integer
        side: 'BUY' or 'SELL'
        """
        self.update_price(symbol, exec_price)
        cost = qty * exec_price
        if side.upper() == 'BUY':
            self.cash -= (cost + commission)
            self.positions[symbol] = self.positions.get(symbol, 0) + qty
        elif side.upper() == 'SELL':
            self.cash += (cost - commission)
            self.positions[symbol] = self.positions.get(symbol, 0) - qty

        # Clean up zero positions
        if self.positions.get(symbol) == 0:
            del self.positions[symbol]
