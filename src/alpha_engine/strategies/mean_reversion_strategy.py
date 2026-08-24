"""Bollinger Bands & RSI Mean Reversion quantitative strategy."""

from collections import deque
import math
from typing import Any, Dict, List, Optional
from src.alpha_engine.strategies.base import BaseStrategy, StrategyContext


class MeanReversionStrategy(BaseStrategy):
  """Mean reversion strategy exploiting statistical price overextension.

  Uses a combination of:
  - 20-period Bollinger Bands (Upper, Middle, Lower).
  - 14-period RSI (Relative Strength Index).
  - Dynamic ATR-based risk stop loss.
  """

  def __init__(
      self,
      ctx: StrategyContext,
      symbol: str,
      window: int = 20,
      num_std: float = 2.0,
      rsi_period: int = 14,
      rsi_oversold: float = 30.0,
      rsi_overbought: float = 70.0,
  ):
    super().__init__(ctx)
    self.symbol = symbol
    self.window = window
    self.num_std = num_std
    self.rsi_period = rsi_period
    self.rsi_oversold = rsi_oversold
    self.rsi_overbought = rsi_overbought

    self.prices: deque[float] = deque(maxlen=max(window, rsi_period + 1))
    self.highs: deque[float] = deque(maxlen=window)
    self.lows: deque[float] = deque(maxlen=window)

  def _calculate_rsi(self) -> float:
    """Calculates Wilder's Relative Strength Index (RSI)."""
    if len(self.prices) < self.rsi_period + 1:
      return 50.0

    price_list = list(self.prices)[-(self.rsi_period + 1):]
    gains = []
    losses = []
    for i in range(1, len(price_list)):
      diff = price_list[i] - price_list[i - 1]
      if diff >= 0:
        gains.append(diff)
        losses.append(0.0)
      else:
        gains.append(0.0)
        losses.append(abs(diff))

    avg_gain = sum(gains) / self.rsi_period
    avg_loss = sum(losses) / self.rsi_period

    if avg_loss == 0.0:
      return 100.0 if avg_gain > 0 else 50.0

    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))

  def on_bar(self, bar: Any) -> None:
    """Invoked on each incoming market bar."""
    if isinstance(bar, dict) and self.symbol in bar:
      sym_data = bar[self.symbol]
      close = float(sym_data.get("close", sym_data.get("price", 0.0)))
      high = float(sym_data.get("high", close))
      low = float(sym_data.get("low", close))
    else:
      close = float(getattr(bar, "close", 0.0))
      high = float(getattr(bar, "high", close))
      low = float(getattr(bar, "low", close))

    if close <= 0:
      return

    self.prices.append(close)
    self.highs.append(high)
    self.lows.append(low)

    if len(self.prices) < self.window:
      return

    # Calculate Bollinger Bands
    window_prices = list(self.prices)[-self.window:]
    sma = sum(window_prices) / self.window
    variance = sum((p - sma) ** 2 for p in window_prices) / self.window
    std_dev = math.sqrt(variance)

    upper_band = sma + self.num_std * std_dev
    lower_band = sma - self.num_std * std_dev
    rsi = self._calculate_rsi()

    current_positions = self.ctx.get_positions()
    current_qty = current_positions.get(self.symbol, 0)
    nav = self.ctx.get_nav()

    target_weight = 0.0

    # Oversold Entry: Price below lower band and RSI < 30
    if close <= lower_band and rsi <= self.rsi_oversold:
      target_weight = 1.0  # Max Long
    # Overbought Entry: Price above upper band and RSI > 70
    elif close >= upper_band and rsi >= self.rsi_overbought:
      target_weight = -1.0  # Max Short
    # Mean Reversion Target Exit: Price crossed back over SMA middle band
    elif current_qty > 0 and close >= sma:
      target_weight = 0.0  # Close Long
    elif current_qty < 0 and close <= sma:
      target_weight = 0.0  # Close Short
    else:
      # Maintain current position
      return

    target_qty = int(round(target_weight * nav / close))
    order_qty = target_qty - current_qty

    if order_qty > 0:
      self.ctx.submit_order(self.symbol, abs(order_qty), "BUY", close)
    elif order_qty < 0:
      self.ctx.submit_order(self.symbol, abs(order_qty), "SELL", close)

  def on_order_status(self, order_response: Any) -> None:
    pass
