from src.alpha_engine.strategies.base import BaseStrategy, StrategyContext, StrategyMetadata
from collections import deque


class TrendStrategy(BaseStrategy):
  """Dual Exponential Moving Average trend following strategy with ATR trailing stops."""

  @classmethod
  def get_metadata(cls) -> StrategyMetadata:
    return StrategyMetadata(
        id="trend",
        name="Dual EMA Momentum Trend Follower",
        category="Trend Following",
        philosophy="价格呈现序列自相关性与动量聚集效应。通过顺应中期均线趋势并让利润奔跑，捕捉资产价格的大级别单边运动波段。",
        mechanics="当快速均线金叉慢速均线时全仓做多；当快线死叉慢线时平仓反手做空或离场，结合 ATR 波动率自适应追踪止损控制单笔最大回撤。",
        suitable_regime="单边上升牛市、大级别突破行情、高动量波动扩张周期。",
        risk_profile="在窄幅横盘无趋势震荡市容易反复遭遇“双重打脸”（Whipsaw）导致连续小幅止损磨损本金。",
        default_params={"fast_period": 10, "slow_period": 30, "atr_multiplier": 2.5},
        param_descriptions={
            "fast_period": "短期均线周期（天数/K线根数），对最新价格变动更敏感",
            "slow_period": "长期基准均线周期，用于过滤短期市场高频噪音",
            "atr_multiplier": "真实波幅 ATR 倍数，动态决定追踪止损与止盈缓冲带",
        },
    )

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

