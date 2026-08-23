"""High-performance multi-asset quant backtest engine with realistic microstructure matching."""

from dataclasses import dataclass
import gc
import logging
import math
from typing import Any, Callable, Dict, Final, List, Optional, Type, Union
import polars as pl

from src.alpha_engine.analytics import PerformanceAnalytics, PerformanceReport, TradeRecord
from src.alpha_engine.data.schema import (
    CLOSE_COL,
    HIGH_COL,
    LOW_COL,
    OPEN_COL,
    SYMBOL_COL,
    TIMESTAMP_COL,
    VOLUME_COL,
    validate_and_normalize_schema,
)
from src.alpha_engine.data.storage import MarketDataManager
from src.alpha_engine.strategies.base import BaseStrategy, StrategyContext, SubPortfolio

FLOAT_TOLERANCE: Final[float] = 1e-9


class BarDict(dict):
  """A dictionary wrapper that supports dot attribute access to match Protobuf and object style."""

  def __getattr__(self, name: str) -> Any:
    if name in self:
      return self[name]
    raise AttributeError(f"No attribute '{name}' in BarDict.")

  def __setattr__(self, name: str, value: Any) -> None:
    self[name] = value


@dataclass
class SlippageModel:
  """Configurable market microstructure slippage model."""
  gamma: float = 0.1
  alpha: float = 1.0
  fixed_bps: float = 0.0

  def compute_slippage_pct(self, qty: int, volume: float) -> float:
    pct = self.fixed_bps / 10000.0
    if volume > 0.0 and self.gamma > 0.0:
      pct += self.gamma * ((qty / volume) ** self.alpha)
    return max(0.0, pct)


@dataclass
class CommissionModel:
  """Configurable brokerage commission model."""
  flat_fee: float = 1.0
  rate: float = 0.0001
  per_share: float = 0.0
  min_fee: float = 1.0
  max_fee_pct: float = 0.01

  def compute_commission(self, qty: int, exec_price: float) -> float:
    notional = qty * exec_price
    comm = self.flat_fee + (notional * self.rate) + (qty * self.per_share)
    comm = max(self.min_fee, comm)
    if self.max_fee_pct > 0.0:
      comm = min(comm, notional * self.max_fee_pct)
    return comm


class BacktestContext(StrategyContext):
  """Simulated execution context for multi-asset cold-data backtesting."""

  def __init__(
      self,
      initial_capital: float = 100000.0,
      slippage_model: Optional[SlippageModel] = None,
      commission_model: Optional[CommissionModel] = None,
      slippage_gamma: float = 0.1,
      commission_rate: float = 0.0001,
      flat_fee: float = 1.0,
  ) -> None:
    self.portfolio = SubPortfolio(initial_capital)
    self._current_time: Optional[int] = None
    self.orders: Dict[str, Dict[str, Any]] = {}
    self.pending_orders: List[Dict[str, Any]] = []
    self.trade_history: List[TradeRecord] = []
    self.nav_history: List[float] = [initial_capital]
    self.timestamp_history: List[int] = []
    self.initial_capital = initial_capital

    self.slippage_model = slippage_model or SlippageModel(gamma=slippage_gamma)
    self.commission_model = commission_model or CommissionModel(
        flat_fee=flat_fee, rate=commission_rate, min_fee=flat_fee
    )

    # Internal order counter for deterministic ordering
    self._order_counter = 0

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
    return {
        "max_leverage": 1.5,
        "max_position": 10000,
        "current_leverage": self.portfolio.get_leverage(),
        "gross_exposure": self.portfolio.get_gross_exposure(),
    }

  def submit_order(
      self,
      symbol: str,
      qty: int,
      side: str,
      price: float = 0.0,
      order_type: str = "MARKET",
  ) -> str:
    self._order_counter += 1
    order_id = f"backtest-{self._order_counter}"
    order = {
        "order_id": order_id,
        "symbol": symbol,
        "qty": int(qty),
        "side": side.upper(),
        "price": float(price),
        "order_type": order_type.upper(),
        "status": "PENDING",
        "created_time": self._current_time,
    }
    self.orders[order_id] = order
    self.pending_orders.append(order)
    logging.debug("Backtest order submitted: %s %d %s, Type: %s, ID: %s", side, qty, symbol, order_type, order_id)
    return order_id

  def cancel_order(self, order_id: str) -> bool:
    if order_id in self.orders and self.orders[order_id]["status"] == "PENDING":
      self.orders[order_id]["status"] = "CANCELLED"
      self.pending_orders = [o for o in self.pending_orders if o["order_id"] != order_id]
      logging.debug("Backtest order cancelled: %s", order_id)
      return True
    return False

  def process_fills_for_bar(self, symbol: str, bar: Any) -> None:
    """Matches pending market and limit orders against incoming bar prices."""
    still_pending = []
    close_price = float(bar.close)
    open_price = float(bar.open) if hasattr(bar, "open") else close_price
    high_price = float(bar.high) if hasattr(bar, "high") else close_price
    low_price = float(bar.low) if hasattr(bar, "low") else close_price
    volume = float(bar.volume) if hasattr(bar, "volume") else 10000.0

    for order in self.pending_orders:
      if order["symbol"] != symbol:
        still_pending.append(order)
        continue

      if order["status"] == "CANCELLED":
        continue

      qty = order["qty"]
      side = order["side"]
      order_type = order.get("order_type", "MARKET")
      limit_price = order.get("price", 0.0)

      is_fillable = True
      base_price = close_price

      if order_type == "LIMIT" and limit_price > 0.0:
        if side == "BUY":
          if low_price <= limit_price:
            base_price = min(open_price, limit_price)
          else:
            is_fillable = False
        elif side == "SELL":
          if high_price >= limit_price:
            base_price = max(open_price, limit_price)
          else:
            is_fillable = False

      if not is_fillable:
        still_pending.append(order)
        continue

      # Compute Microstructure Slippage
      slippage_pct = self.slippage_model.compute_slippage_pct(qty, volume)
      if side == "BUY":
        exec_price = base_price * (1.0 + slippage_pct)
        slippage_cost = (exec_price - base_price) * qty
      else:
        exec_price = base_price * (1.0 - slippage_pct)
        slippage_cost = (base_price - exec_price) * qty

      commission = self.commission_model.compute_commission(qty, exec_price)
      realized_pnl = self.portfolio.process_fill(symbol, qty, side, exec_price, commission)

      order["status"] = "FILLED"
      order["exec_price"] = exec_price
      order["commission"] = commission

      trade = TradeRecord(
          timestamp=self._current_time or 0,
          order_id=order["order_id"],
          symbol=symbol,
          side=side,
          qty=qty,
          order_price=limit_price if order_type == "LIMIT" else base_price,
          exec_price=exec_price,
          slippage_cost=slippage_cost,
          commission=commission,
          realized_pnl=realized_pnl,
          cash_after=self.portfolio.cash,
          position_after=self.portfolio.positions.get(symbol, 0),
      )
      self.trade_history.append(trade)
      logging.debug(
          "Backtest order filled: %s %d %s @ %f, slippage: %f, commission: %f",
          side,
          qty,
          symbol,
          exec_price,
          slippage_cost,
          commission,
      )

    self.pending_orders = still_pending

  def process_fills_for_symbol(self, symbol: str, close_price: float, volume: float) -> None:
    """Backwards compatibility helper matching close_price and volume."""
    mock_bar = BarDict(open=close_price, high=close_price, low=close_price, close=close_price, volume=volume)
    self.process_fills_for_bar(symbol, mock_bar)

  def record_nav(self) -> None:
    """Records the latest portfolio NAV and event timestamp."""
    self.nav_history.append(self.get_nav())
    if self._current_time is not None:
      self.timestamp_history.append(self._current_time)


def compute_performance_metrics(
    nav_history: List[float],
    initial_capital: float,
    timestamps: Optional[List[int]] = None,
    trades: Optional[List[TradeRecord]] = None,
) -> Dict[str, Any]:
  """Computes performance metrics dictionary for backwards compatibility."""
  report = PerformanceAnalytics.generate_report(
      nav_history=nav_history,
      initial_capital=initial_capital,
      timestamps=timestamps,
      trades=trades,
  )
  return report.to_dict()


def run_backtest_session(
    market_data: Union[str, List[str], MarketDataManager, pl.DataFrame, pl.LazyFrame],
    strategy_cls: Type[BaseStrategy],
    initial_capital: float = 100000.0,
    slippage_gamma: float = 0.1,
    commission_rate: float = 0.0001,
    flat_fee: float = 1.0,
    slippage_model: Optional[SlippageModel] = None,
    commission_model: Optional[CommissionModel] = None,
    benchmark_symbol: Optional[str] = None,
    symbols: Optional[List[str]] = None,
    start_ts: Optional[int] = None,
    end_ts: Optional[int] = None,
    **strategy_kwargs: Any,
) -> Dict[str, Any]:
  """Executes a multi-asset event-driven backtest session with strict temporal isolation."""
  gc.collect()

  ctx = BacktestContext(
      initial_capital=initial_capital,
      slippage_model=slippage_model,
      commission_model=commission_model,
      slippage_gamma=slippage_gamma,
      commission_rate=commission_rate,
      flat_fee=flat_fee,
  )
  strategy = strategy_cls(ctx, **strategy_kwargs)

  # Materialize / scan input market data
  if isinstance(market_data, MarketDataManager):
    sym_list = symbols or market_data.list_available_symbols()
    lazy_df = market_data.scan_bars(sym_list, start_ts=start_ts, end_ts=end_ts)
    df = lazy_df.collect()
  elif isinstance(market_data, pl.LazyFrame):
    df = market_data.collect()
  elif isinstance(market_data, pl.DataFrame):
    df = market_data
  elif isinstance(market_data, list):
    lazy_df = pl.scan_parquet(market_data).sort(TIMESTAMP_COL, descending=False)
    df = lazy_df.collect()
  elif isinstance(market_data, str):
    lazy_df = pl.scan_parquet(market_data).sort(TIMESTAMP_COL, descending=False)
    df = lazy_df.collect()
  else:
    raise ValueError(f"Unsupported market_data type: {type(market_data)}")

  if df.height == 0:
    return compute_performance_metrics(ctx.nav_history, initial_capital)

  norm_df = validate_and_normalize_schema(df).sort([TIMESTAMP_COL, SYMBOL_COL])

  current_ts = None
  current_group: List[Dict[str, Any]] = []

  def process_group(ts: int, rows: List[Dict[str, Any]]) -> None:
    ctx.set_mock_time(ts)

    # 1. Update marked prices for symbols in this event step
    for row in rows:
      ctx.portfolio.update_price(row[SYMBOL_COL], row[CLOSE_COL])

    # 2. Process fills for any pending orders using current bar prices
    for row in rows:
      bar = BarDict(
          symbol=row[SYMBOL_COL],
          timestamp=row[TIMESTAMP_COL],
          open=row[OPEN_COL],
          high=row[HIGH_COL],
          low=row[LOW_COL],
          close=row[CLOSE_COL],
          volume=row[VOLUME_COL],
      )
      ctx.process_fills_for_bar(row[SYMBOL_COL], bar)

    # 3. Construct multi-symbol bar_dict for strategy
    bar_dict = {}
    for row in rows:
      sym = row[SYMBOL_COL]
      bar_dict[sym] = BarDict(
          symbol=sym,
          timestamp=row[TIMESTAMP_COL],
          open=row[OPEN_COL],
          high=row[HIGH_COL],
          low=row[LOW_COL],
          close=row[CLOSE_COL],
          volume=row[VOLUME_COL],
      )

    # 4. Trigger strategy.on_bar callback
    strategy.on_bar(bar_dict)

    # 5. Record NAV
    ctx.record_nav()

  # Stream chronologically to completely eliminate lookahead bias
  for row in norm_df.iter_rows(named=True):
    ts = row[TIMESTAMP_COL]
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

  # Generate performance report
  report = PerformanceAnalytics.generate_report(
      nav_history=ctx.nav_history,
      initial_capital=initial_capital,
      timestamps=ctx.timestamp_history,
      trades=ctx.trade_history,
  )

  return report.to_dict()
