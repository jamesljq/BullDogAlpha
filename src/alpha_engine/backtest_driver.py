import gc
import uuid
import math
from typing import Final, Dict, List, Any, Type
import logging
import polars as pl
from src.alpha_engine.strategies.base import BaseStrategy, StrategyContext, SubPortfolio

FLOAT_TOLERANCE: Final[float] = 1e-9

class BarDict(dict):
    """A dictionary wrapper that supports attribute access to match protobuf style."""
    def __getattr__(self, name: str) -> Any:
        if name in self:
            return self[name]
        raise AttributeError(f"No attribute {name}")
    
    def __setattr__(self, name: str, value: Any) -> None:
        self[name] = value

class BacktestContext(StrategyContext):
    """Simulated execution context isolated for cold-data backtesting."""
    def __init__(self, initial_capital: float = 100000.0, slippage_gamma: float = 0.1, commission_rate: float = 0.0001, flat_fee: float = 1.0) -> None:
        self.portfolio = SubPortfolio(initial_capital)
        self._current_time = None
        self.orders: Dict[str, Dict[str, Any]] = {}
        self.pending_orders: List[Dict[str, Any]] = []
        self.slippage_gamma = slippage_gamma
        self.commission_rate = commission_rate
        self.flat_fee = flat_fee
        self.nav_history: List[float] = [initial_capital]
        self.initial_capital = initial_capital

    def set_mock_time(self, timestamp: int) -> None:
        self._current_time = timestamp

    def now(self) -> Any:
        return self._current_time

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
        logging.debug("Backtest order submitted: %s %d %s, ID: %s", side, qty, symbol, order_id)
        return order_id

    def cancel_order(self, order_id: str) -> bool:
        if order_id in self.orders and self.orders[order_id]["status"] == "PENDING":
            self.orders[order_id]["status"] = "CANCELLED"
            self.pending_orders = [o for o in self.pending_orders if o["order_id"] != order_id]
            logging.debug("Backtest order cancelled: %s", order_id)
            return True
        return False

    def process_fills_for_symbol(self, symbol: str, close_price: float, volume: float) -> None:
        """Processes fills for the given symbol using linear slippage and fixed commissions."""
        still_pending = []
        for order in self.pending_orders:
            if order["symbol"] != symbol:
                still_pending.append(order)
                continue

            if order["status"] == "CANCELLED":
                continue

            qty = order["qty"]
            side = order["side"]

            # Calculate Microstructural Slippage
            if volume > 0.0:
                slippage_pct = self.slippage_gamma * (qty / volume)
            else:
                slippage_pct = 0.0

            if side.upper() == "BUY":
                exec_price = close_price * (1.0 + slippage_pct)
            else:
                exec_price = close_price * (1.0 - slippage_pct)

            commission = qty * exec_price * self.commission_rate + self.flat_fee
            self.portfolio.process_fill(symbol, qty, side, exec_price, commission)

            order["status"] = "FILLED"
            order["exec_price"] = exec_price
            order["commission"] = commission
            logging.debug("Backtest order filled: %s %d %s @ %f, commission: %f", side, qty, symbol, exec_price, commission)

        self.pending_orders = still_pending

    def record_nav(self) -> None:
        self.nav_history.append(self.get_nav())

def compute_performance_metrics(nav_history: List[float], initial_capital: float) -> Dict[str, float]:
    """Computes final P&L, annualized Sharpe Ratio, downside Sortino Ratio, and Max Drawdown."""
    if not nav_history:
        return {"sharpe_ratio": 0.0, "sortino_ratio": 0.0, "max_drawdown": 0.0, "final_pnl": 0.0}

    final_pnl = nav_history[-1] - initial_capital

    # Returns series
    returns = []
    for i in range(1, len(nav_history)):
        prev = nav_history[i - 1]
        if prev > 0.0:
            returns.append((nav_history[i] - prev) / prev)
        else:
            returns.append(0.0)

    # Average and Standard Deviation
    n = len(returns)
    if n > 1:
        mean_return = sum(returns) / n
        var_return = sum((r - mean_return) ** 2 for r in returns) / (n - 1)
        std_return = math.sqrt(var_return)
    else:
        mean_return = 0.0
        std_return = 0.0

    # Sharpe Ratio (annualized using minutely scaling factor sqrt(252 * 390))
    annualization_factor = math.sqrt(252 * 390)
    sharpe_ratio = (mean_return / std_return * annualization_factor) if std_return > 0.0 else 0.0

    # Sortino Ratio downside deviation
    if n > 1:
        downside_diffs = [min(r, 0.0) for r in returns]
        downside_variance = sum(d ** 2 for d in downside_diffs) / (n - 1)
        downside_std = math.sqrt(downside_variance)
    else:
        downside_std = 0.0

    sortino_ratio = (mean_return / downside_std * annualization_factor) if downside_std > 0.0 else 0.0

    # Maximum Drawdown
    peak = -float('inf')
    max_dd = 0.0
    for nav in nav_history:
        if nav > peak:
            peak = nav
        if peak > 0.0:
            dd = (peak - nav) / peak
            if dd > max_dd:
                max_dd = dd

    return {
        "sharpe_ratio": sharpe_ratio,
        "sortino_ratio": sortino_ratio,
        "max_drawdown": max_dd,
        "final_pnl": final_pnl
    }

def run_backtest_session(
    parquet_path: str,
    strategy_cls: Type[BaseStrategy],
    initial_capital: float = 100000.0,
    slippage_gamma: float = 0.1,
    commission_rate: float = 0.0001,
    flat_fee: float = 1.0,
    **strategy_kwargs: Any
) -> Dict[str, float]:
    """Executes a single, fully encapsulated backtest session with strict state isolation."""
    logging.info("Loading cold data from partitioned parquet: %s", parquet_path)

    # Explicit garbage collection to enforce clean state memory boundary
    gc.collect()

    ctx = BacktestContext(
        initial_capital=initial_capital,
        slippage_gamma=slippage_gamma,
        commission_rate=commission_rate,
        flat_fee=flat_fee
    )
    strategy = strategy_cls(ctx, **strategy_kwargs)

    # Fast vector scanning via Polars, sorted strictly by event time
    lazy_df = pl.scan_parquet(parquet_path).sort("timestamp", descending=False)
    df = lazy_df.collect()

    current_ts = None
    current_group: List[Dict[str, Any]] = []

    def process_group(ts: int, rows: List[Dict[str, Any]]) -> None:
        ctx.set_mock_time(ts)

        # 1. Update prices for all symbols in this group
        for row in rows:
            ctx.portfolio.update_price(row["symbol"], row["close"])

        # 2. Process fills for any pending orders using current close and volume
        for row in rows:
            ctx.process_fills_for_symbol(row["symbol"], row["close"], row["volume"])

        # 3. Build the bar_dict mapping symbol -> BarDict
        bar_dict = {}
        for row in rows:
            sym = row["symbol"]
            bar_dict[sym] = BarDict(
                symbol=sym,
                timestamp=row["timestamp"],
                open=row["open"],
                high=row["high"],
                low=row["low"],
                close=row["close"],
                volume=row["volume"]
            )

        # 4. Trigger strategy.on_bar
        strategy.on_bar(bar_dict)

        # 5. Record NAV
        ctx.record_nav()

    # Stream record batches line-by-line chronologically to eliminate lookahead bias
    for row in df.iter_rows(named=True):
        ts = row["timestamp"]
        if current_ts is None:
            current_ts = ts

        if ts != current_ts:
            process_group(current_ts, current_group)
            current_ts = ts
            current_group = [row]
        else:
            current_group.append(row)

    if current_group and current_ts is not None:
        process_group(current_ts, current_group)

    return compute_performance_metrics(ctx.nav_history, initial_capital)
