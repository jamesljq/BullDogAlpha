"""Cointegrated Pairs Statistical Arbitrage Strategy."""

from collections import deque
import math
from typing import Any, Dict, List, Optional
from src.alpha_engine.strategies.base import BaseStrategy, StrategyContext


class StatArbStrategy(BaseStrategy):
  """Pairs Statistical Arbitrage strategy with rolling dynamic hedge ratio.

  Computes rolling OLS spread:
    Spread = Price_A - (beta * Price_B)
    Z-Score = (Spread - Mean_Spread) / Std_Spread

  Executes mean-reverting pairs trades with risk stop loss protection.
  """

  def __init__(
      self,
      ctx: StrategyContext,
      symbol_a: str,
      symbol_b: str,
      window: int = 30,
      entry_z: float = 2.0,
      exit_z: float = 0.5,
      stop_z: float = 3.5,
  ):
    super().__init__(ctx)
    self.symbol_a = symbol_a
    self.symbol_b = symbol_b
    self.window = window
    self.entry_z = entry_z
    self.exit_z = exit_z
    self.stop_z = stop_z

    self.prices_a: deque[float] = deque(maxlen=window)
    self.prices_b: deque[float] = deque(maxlen=window)

  def on_bar(self, bar: Any) -> None:
    """Processes synchronized bars for pair (symbol_a, symbol_b)."""
    if not isinstance(bar, dict) or self.symbol_a not in bar or self.symbol_b not in bar:
      return

    close_a = float(bar[self.symbol_a].get("close", bar[self.symbol_a].get("price", 0.0)))
    close_b = float(bar[self.symbol_b].get("close", bar[self.symbol_b].get("price", 0.0)))

    if close_a <= 0 or close_b <= 0:
      return

    self.prices_a.append(close_a)
    self.prices_b.append(close_b)

    if len(self.prices_a) < self.window:
      return

    pa = list(self.prices_a)
    pb = list(self.prices_b)

    # 1. Compute OLS Beta = Cov(A, B) / Var(B)
    mean_a = sum(pa) / self.window
    mean_b = sum(pb) / self.window

    cov = sum((pa[i] - mean_a) * (pb[i] - mean_b) for i in range(self.window)) / self.window
    var_b = sum((pb[i] - mean_b) ** 2 for i in range(self.window)) / self.window

    raw_beta = cov / var_b if var_b > 1e-8 else 1.0
    beta = max(0.05, raw_beta) if raw_beta > 0 else 1.0


    # 2. Compute Spreads & Z-Score
    spreads = [pa[i] - beta * pb[i] for i in range(self.window)]
    mean_spread = sum(spreads) / self.window
    var_spread = sum((s - mean_spread) ** 2 for s in spreads) / self.window
    std_spread = math.sqrt(var_spread)

    if std_spread < 1e-8:
      return

    current_spread = spreads[-1]
    z_score = (current_spread - mean_spread) / std_spread

    # 3. Position & NAV
    positions = self.ctx.get_positions()
    qty_a = positions.get(self.symbol_a, 0)
    qty_b = positions.get(self.symbol_b, 0)
    nav = self.ctx.get_nav()

    # Half portfolio allocated to leg A, half to leg B
    half_nav = nav * 0.45
    base_qty_a = int(round(half_nav / close_a))
    base_qty_b = int(round(half_nav / close_b))

    target_qty_a = qty_a
    target_qty_b = qty_b

    # Long Spread (A undervalued, B overvalued): Buy A, Sell B
    if z_score <= -self.entry_z and z_score > -self.stop_z:
      target_qty_a = base_qty_a
      target_qty_b = -int(round(base_qty_a * beta * (close_a / close_b)))
    # Short Spread (A overvalued, B undervalued): Sell A, Buy B
    elif z_score >= self.entry_z and z_score < self.stop_z:
      target_qty_a = -base_qty_a
      target_qty_b = int(round(base_qty_a * beta * (close_a / close_b)))
    # Mean Reversion Target Exit or Stop Loss Protection: Close both
    elif abs(z_score) <= self.exit_z or abs(z_score) >= self.stop_z:
      target_qty_a = 0
      target_qty_b = 0
    else:
      return

    order_a = target_qty_a - qty_a
    order_b = target_qty_b - qty_b

    if order_a > 0:
      self.ctx.submit_order(self.symbol_a, abs(order_a), "BUY", close_a)
    elif order_a < 0:
      self.ctx.submit_order(self.symbol_a, abs(order_a), "SELL", close_a)

    if order_b > 0:
      self.ctx.submit_order(self.symbol_b, abs(order_b), "BUY", close_b)
    elif order_b < 0:
      self.ctx.submit_order(self.symbol_b, abs(order_b), "SELL", close_b)

  def on_order_status(self, order_response: Any) -> None:
    pass
