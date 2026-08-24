"""Cross-Sectional Multi-Asset Momentum and Factor Ranking Strategy."""

from collections import deque
import math
from typing import Any, Dict, List, Optional
from src.alpha_engine.strategies.base import BaseStrategy, StrategyContext, StrategyMetadata



class CrossSectionalMomentumStrategy(BaseStrategy):
  """Cross-sectional multi-asset momentum strategy with volatility parity sizing."""

  @classmethod
  def get_metadata(cls) -> StrategyMetadata:
    return StrategyMetadata(
        id="momentum",
        name="Cross-Sectional Factor Momentum",
        category="Factor Momentum",
        philosophy_en="Cross-sectional momentum anomaly (Jegadeesh & Titman): within a multi-asset universe, top trailing performers (Winners) systematically outperform laggards (Losers) over intermediate investment horizons.",
        philosophy_zh="截面多资产动量效应（Jegadeesh & Titman 经典理论）：在资产池内部，过去表现最强的资产（Winners）在未来一段周期内会继续跑赢表现最差的资产（Losers）。",
        mechanics_en="Ranks full universe by cumulative trailing returns every N bars, allocating to Top-K winners with inverse-volatility risk parity weighting, and underweighting/shorting bottom laggards.",
        mechanics_zh="每隔 N 个周期对资产池全量标的按过去 Lookback 周期累积收益打分排序，按反波动率风险平价权重做多 Top 领头羊，做空/减持 Bottom 滞涨股。",
        suitable_regime_en="Broad macro bull expansions, sector rotation trends, and structural growth leadership phases.",
        suitable_regime_zh="板块轮动加速行情、结构性分化牛市、科技成长龙头主升浪。",
        risk_profile_en="Vulnerable to sharp factor reversals and 'Momentum Crashes' when defensive value abruptly outperforms high-beta growth.",
        risk_profile_zh="在遭遇市场风格剧烈切换（如高低切换、价值防御突发跑赢成长动量）时，可能发生“动量崩溃（Momentum Crash）”。",
        default_params={"lookback": 20, "top_k": 2, "rebalance_interval": 5, "allow_short": True},
        param_schemas={
            "lookback": {
                "name": "Lookback Period",
                "default_value": 20,
                "valid_range": "[5, 60] bars",
                "description_en": "Trailing window used to calculate asset performance return ranking scores.",
                "description_zh": "动量回溯收益率统计周期（天数/K线根数）。",
            },
            "top_k": {
                "name": "Top Selected Assets",
                "default_value": 2,
                "valid_range": "[1, 10]",
                "description_en": "Number of top-ranked winner assets to include in the long portfolio basket.",
                "description_zh": "多头组合选取的头部最强资产数量。",
            },
            "rebalance_interval": {
                "name": "Rebalance Frequency",
                "default_value": 5,
                "valid_range": "[1, 20] bars",
                "description_en": "Periodic interval for recalculating factor weights and portfolio rebalancing.",
                "description_zh": "组合再平衡调仓频率（K线根数）。",
            },
        },
    )


  def __init__(

      self,
      ctx: StrategyContext,
      symbols: List[str],
      lookback: int = 20,
      top_k: int = 2,
      rebalance_interval: int = 5,
      allow_short: bool = True,
  ):
    super().__init__(ctx)
    self.symbols = list(symbols)
    self.lookback = lookback
    self.top_k = min(top_k, max(1, len(symbols) // 2))
    self.rebalance_interval = rebalance_interval
    self.allow_short = allow_short

    self.price_history: Dict[str, deque[float]] = {
        s: deque(maxlen=lookback + 1) for s in self.symbols
    }
    self.step_count = 0

  def on_bar(self, bar: Any) -> None:
    """Processes synchronized cross-asset bars."""
    if not isinstance(bar, dict):
      return

    current_prices: Dict[str, float] = {}
    for sym in self.symbols:
      if sym in bar:
        close = float(bar[sym].get("close", bar[sym].get("price", 0.0)))
        if close > 0:
          self.price_history[sym].append(close)
          current_prices[sym] = close

    self.step_count += 1

    # Check if all symbols have enough historical bars
    if any(len(self.price_history[s]) < self.lookback + 1 for s in self.symbols):
      return

    # Check rebalance schedule
    if self.step_count % self.rebalance_interval != 0:
      return

    # 1. Calculate trailing momentum return & volatility
    momentum_scores: Dict[str, float] = {}
    inv_vols: Dict[str, float] = {}

    for sym in self.symbols:
      hist = list(self.price_history[sym])
      ret = (hist[-1] - hist[0]) / hist[0]
      momentum_scores[sym] = ret

      # Daily returns volatility
      daily_returns = [(hist[i] - hist[i - 1]) / hist[i - 1] for i in range(1, len(hist))]
      mean_r = sum(daily_returns) / len(daily_returns)
      variance = sum((r - mean_r) ** 2 for r in daily_returns) / len(daily_returns)
      vol = math.sqrt(variance)
      inv_vols[sym] = 1.0 / max(1e-4, vol)

    # 2. Rank symbols
    sorted_syms = sorted(self.symbols, key=lambda s: momentum_scores[s], reverse=True)
    top_winners = sorted_syms[:self.top_k]
    bottom_losers = sorted_syms[-self.top_k:]

    # 3. Compute target portfolio weights
    nav = self.ctx.get_nav()
    positions = self.ctx.get_positions()

    target_weights: Dict[str, float] = {s: 0.0 for s in self.symbols}

    # Weight top winners proportionally to inverse volatility
    win_inv_sum = sum(inv_vols[s] for s in top_winners) or 1.0
    for s in top_winners:
      target_weights[s] = (inv_vols[s] / win_inv_sum) * 0.85

    # Weight bottom losers (if shorting allowed)
    if self.allow_short:
      loss_inv_sum = sum(inv_vols[s] for s in bottom_losers) or 1.0
      for s in bottom_losers:
        if s not in top_winners:
          target_weights[s] = -(inv_vols[s] / loss_inv_sum) * 0.85

    # 4. Generate rebalance orders
    for sym in self.symbols:
      if sym not in current_prices:
        continue

      close = current_prices[sym]
      weight = target_weights[sym]
      target_qty = int(round(weight * nav / close))
      curr_qty = positions.get(sym, 0)
      order_qty = target_qty - curr_qty

      if order_qty > 0:
        self.ctx.submit_order(sym, abs(order_qty), "BUY", close)
      elif order_qty < 0:
        self.ctx.submit_order(sym, abs(order_qty), "SELL", close)

  def on_order_status(self, order_response: Any) -> None:
    pass
