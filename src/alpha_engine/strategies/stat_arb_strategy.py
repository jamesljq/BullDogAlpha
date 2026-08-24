"""Cointegrated Pairs Statistical Arbitrage Strategy."""

from collections import deque
import math
from typing import Any, Dict, List, Optional
from src.alpha_engine.strategies.base import BaseStrategy, StrategyContext, StrategyMetadata



class StatArbStrategy(BaseStrategy):
  """Pairs Statistical Arbitrage strategy with rolling dynamic hedge ratio."""

  @classmethod
  def get_metadata(cls) -> StrategyMetadata:
    return StrategyMetadata(
        id="stat_arb",
        name="Cointegrated Pairs Statistical Arbitrage",
        category="Statistical Arbitrage",
        philosophy_en="Economically interconnected asset pairs (e.g. MSFT vs AAPL) exhibit stationary long-term cointegration. Short-term spread discrepancies inevitably mean-revert toward statistical equilibrium.",
        philosophy_zh="具有共同经济驱动因子的高关联资产对（如 MSFT vs AAPL）具有长期协整关系，短期价差偏离会向统计均衡中枢靠拢。",
        mechanics_en="Computes rolling OLS hedge ratio Beta to construct stationary spread. Buys spread when Z-Score <= -2.0; shorts spread when Z-Score >= 2.0; exits on zero cross, with |Z| >= 3.5 hard stop.",
        mechanics_zh="通过滚动 OLS 回归实时计算动态对冲比率 Beta 构建平稳价差。当 Z-Score <= -2.0 时做多价差；Z-Score >= 2.0 时做空价差；回归至 0 轴时平仓，偏离 > 3.5 触发结构性断裂硬止损。",
        suitable_regime_en="Market-neutral environments, equity long/short hedging, and high sector-internal correlation regimes.",
        suitable_regime_zh="市场中性环境、两融配对对冲、大盘剧烈震荡但板块内部相对稳定的阶段。",
        risk_profile_en="Structural cointegration breakdown due to idiosyncratic fundamental events (e.g. earnings shocks, M&A restructuring).",
        risk_profile_zh="协整关系可能因为企业基本面突变（如重大财报暴雷、并购重组）而彻底瓦解（Structural Break）。",
        default_params={"window": 30, "entry_z": 2.0, "exit_z": 0.5, "stop_z": 3.5},
        param_schemas={
            "window": {
                "name": "OLS Estimation Window",
                "default_value": 30,
                "valid_range": "[15, 120] bars",
                "description_en": "Rolling lookback window for dynamic hedge ratio Beta and spread Z-score computation.",
                "description_zh": "协整对冲系数 Beta 与价差均值/方差的滚动计算窗口长度。",
            },
            "entry_z": {
                "name": "Entry Z-Score Threshold",
                "default_value": 2.0,
                "valid_range": "[1.0, 3.0]",
                "description_en": "Statistical standard deviation threshold to trigger pairs divergence entry.",
                "description_zh": "建仓开仓的 Z-score 标准差偏离阈值（通常为 1.5 ~ 2.5）。",
            },
            "exit_z": {
                "name": "Mean-Reversion Exit Threshold",
                "default_value": 0.5,
                "valid_range": "[0.0, 1.0]",
                "description_en": "Convergence threshold to close spread trade and lock in mean-reverting alpha.",
                "description_zh": "均值回归目标平仓阈值（接近 0.0 时平仓止盈）。",
            },
            "stop_z": {
                "name": "Structural Break Stop Loss",
                "default_value": 3.5,
                "valid_range": "[2.5, 6.0]",
                "description_en": "Emergency exit threshold to truncate losses if pair permanently diverges.",
                "description_zh": "极端脱节硬止损阈值（防止单边脱节导致无限亏损）。",
            },
        },
    )


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
