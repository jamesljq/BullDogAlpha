import uuid
from typing import Dict, List, Any, Optional
from src.alpha_engine.strategies.base import StrategyContext, BaseStrategy, SubPortfolio

class BacktestContext(StrategyContext):
    def __init__(self, initial_cash: float):
        self.portfolio = SubPortfolio(initial_cash)
        self.orders: Dict[str, Dict[str, Any]] = {}
        self.pending_orders: List[Dict[str, Any]] = []

    def get_positions(self) -> Dict[str, int]:
        return self.portfolio.positions

    def get_balance(self) -> float:
        return self.portfolio.cash

    def get_nav(self) -> float:
        return self.portfolio.get_nav()

    def get_available_risk_limits(self) -> Dict[str, Any]:
        return {"max_leverage": 1.5, "max_position": 1000}

    def submit_order(self, symbol: str, qty: int, side: str, price: float = 0.0) -> str:
        order_id = f"backtest-{uuid.uuid4()}"
        order = {
            "order_id": order_id,
            "symbol": symbol,
            "qty": qty,
            "side": side,
            "price": price,
            "status": "PENDING"
        }
        self.orders[order_id] = order
        self.pending_orders.append(order)
        return order_id

    def cancel_order(self, order_id: str) -> bool:
        if order_id in self.orders and self.orders[order_id]["status"] == "PENDING":
            self.orders[order_id]["status"] = "CANCELLED"
            self.pending_orders = [o for o in self.pending_orders if o["order_id"] != order_id]
            return True
        return False

    def process_pending_orders(self, current_prices: Dict[str, float], slippage_gamma: float = 0.1, commission_rate: float = 0.0001):
        temp_pending = list(self.pending_orders)
        self.pending_orders.clear()
        
        for order in temp_pending:
            symbol = order["symbol"]
            qty = order["qty"]
            side = order["side"]
            
            if order["status"] == "CANCELLED":
                continue
                
            price_base = current_prices.get(symbol, order["price"])
            if price_base <= 0:
                continue
                
            # Slippage simulation using mock volume
            slippage_pct = slippage_gamma * (qty / 100000.0)
            if side.upper() == 'BUY':
                exec_price = price_base * (1.0 + slippage_pct)
            else:
                exec_price = price_base * (1.0 - slippage_pct)
                
            commission = qty * exec_price * commission_rate
            self.portfolio.process_fill(symbol, qty, side, exec_price, commission)
            
            order["status"] = "FILLED"
            order["exec_price"] = exec_price
            order["commission"] = commission

class LiveContext(StrategyContext):
    def __init__(self, initial_cash: float):
        self.portfolio = SubPortfolio(initial_cash)
        self.orders: Dict[str, Dict[str, Any]] = {}
        
    def get_positions(self) -> Dict[str, int]:
        return self.portfolio.positions

    def get_balance(self) -> float:
        return self.portfolio.cash

    def get_nav(self) -> float:
        return self.portfolio.get_nav()

    def get_available_risk_limits(self) -> Dict[str, Any]:
        return {"max_leverage": 1.0, "max_position": 1000}

    def submit_order(self, symbol: str, qty: int, side: str, price: float = 0.0) -> str:
        order_id = f"live-{uuid.uuid4()}"
        order = {
            "order_id": order_id,
            "symbol": symbol,
            "qty": qty,
            "side": side,
            "price": price,
            "status": "PENDING"
        }
        self.orders[order_id] = order
        return order_id

    def cancel_order(self, order_id: str) -> bool:
        if order_id in self.orders and self.orders[order_id]["status"] == "PENDING":
            self.orders[order_id]["status"] = "CANCELLED"
            return True
        return False

class StrategyOrchestrator:
    def __init__(self):
        self.strategies: List[BaseStrategy] = []
        self.symbols_map: Dict[BaseStrategy, List[str]] = {}
        self.contexts_map: Dict[BaseStrategy, StrategyContext] = {}
        
        # Barrier Synchronization Buffers
        self.strategy_buffers: Dict[BaseStrategy, Dict[str, Dict[str, Any]]] = {}
        self.strategy_current_time: Dict[BaseStrategy, Optional[Any]] = {}
        self.last_known_bars: Dict[str, Dict[str, Any]] = {}

    def register_strategy(self, strategy: BaseStrategy, symbols: List[str], ctx: StrategyContext):
        self.strategies.append(strategy)
        self.symbols_map[strategy] = symbols
        self.contexts_map[strategy] = ctx
        self.strategy_buffers[strategy] = {}
        self.strategy_current_time[strategy] = None

    def on_incoming_bar(self, symbol: str, bar: Dict[str, Any]):
        self.last_known_bars[symbol] = bar
        bar_time = bar.get("time")
        
        for strategy in self.strategies:
            subscribed_symbols = self.symbols_map[strategy]
            if symbol not in subscribed_symbols:
                continue
                
            current_time = self.strategy_current_time[strategy]
            
            if current_time is None or bar_time > current_time:
                # Flush the barrier if time has advanced and some symbols were missing
                if current_time is not None and len(self.strategy_buffers[strategy]) > 0:
                    self.flush_strategy_barrier(strategy)
                self.strategy_current_time[strategy] = bar_time
                self.strategy_buffers[strategy] = {symbol: bar}
            elif bar_time == current_time:
                self.strategy_buffers[strategy][symbol] = bar
            else:
                continue
                
            if len(self.strategy_buffers[strategy]) == len(subscribed_symbols):
                self.trigger_strategy_on_bar(strategy)

    def trigger_strategy_on_bar(self, strategy: BaseStrategy):
        buffered_bars = self.strategy_buffers[strategy]
        ctx = self.contexts_map[strategy]
        
        if isinstance(ctx, (BacktestContext, LiveContext)):
            for symbol, bar in buffered_bars.items():
                ctx.portfolio.update_price(symbol, bar['close'])
                
            if isinstance(ctx, BacktestContext):
                prices = {s: b['close'] for s, b in buffered_bars.items()}
                ctx.process_pending_orders(prices)
                
        strategy.on_bar(buffered_bars)
        self.strategy_buffers[strategy] = {}

    def flush_strategy_barrier(self, strategy: BaseStrategy):
        current_time = self.strategy_current_time[strategy]
        subscribed_symbols = self.symbols_map[strategy]
        buffered_bars = self.strategy_buffers[strategy]
        
        for symbol in subscribed_symbols:
            if symbol not in buffered_bars:
                last_bar = self.last_known_bars.get(symbol, {})
                last_close = last_bar.get("close", 1.0)
                
                # Zero-Volume Forward Fill
                virtual_bar = {
                    "time": current_time,
                    "open": last_close,
                    "high": last_close,
                    "low": last_close,
                    "close": last_close,
                    "volume": 0.0
                }
                buffered_bars[symbol] = virtual_bar
                
        self.trigger_strategy_on_bar(strategy)
