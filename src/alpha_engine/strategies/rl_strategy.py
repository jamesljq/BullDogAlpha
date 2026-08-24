import os
from typing import Any, Optional
import numpy as np
from src.alpha_engine.strategies.base import BaseStrategy, StrategyContext, StrategyMetadata
from src.alpha_engine.rl.features import FeatureExtractor, ActionAdapter


class RLStrategy(BaseStrategy):
  """Deep Reinforcement Learning microstructure policy strategy."""

  @classmethod
  def get_metadata(cls) -> StrategyMetadata:
    return StrategyMetadata(
        id="rl_strategy",
        name="Deep RL Microstructure Policy",
        category="Machine Learning / RL",
        philosophy="市场微观结构包含非线性非高斯的潜空间特征。通过深度强化学习（PPO/DQN）直接学习从微观订单流状态到最优仓位权重的端到端映射策略。",
        mechanics="提取对数收益率、滚动均值/方差、Z-Score、当前归一化持仓与现金比例构成连续状态向量，通过 ONNX 神经网络实时推理输出目标仓位权重，经由动作适配器约束下单。",
        suitable_regime="高频微观结构波动、订单流失衡突发事件、流动性快速变动的日内行情。",
        risk_profile="神经网络策略存在“黑盒/不可解释风险”以及在未见过的极端宏观突发事件下的模型过拟合（Overfitting）与分布漂移风险。",
        default_params={"window_size": 20, "max_position": 1000, "confidence_threshold": 0.70},
        param_descriptions={
            "window_size": "微观特征提取器状态滑动窗口长度",
            "max_position": "单标的最大持仓股数上限约束",
            "confidence_threshold": "模型输出动作置信度过滤门槛",
        },
    )

  def __init__(
      self,
      ctx: StrategyContext,
      symbol: str,
      model_path: Optional[str] = None,
      window_size: int = 20,
      max_position: int = 1000,
      vol_target: Optional[float] = None,
      min_qty: int = 5,
      min_value: float = 100.0,
  ):
    super().__init__(ctx)
    self.symbol = symbol
    self.max_position = max_position
    self.feature_extractor = FeatureExtractor(window_size=window_size)
    self.action_adapter = ActionAdapter(
        symbol=symbol,
        min_qty=min_qty,
        min_value=min_value,
        vol_target=vol_target,
        vol_window=window_size,
    )

    self.ort_session = None
    if model_path and os.path.exists(model_path):
      import onnxruntime as ort
      self.ort_session = ort.InferenceSession(model_path)

  def on_bar(self, bar: Any) -> None:
    symbol_bar = bar[self.symbol]
    close = float(symbol_bar['close'])
    features = self.feature_extractor.push(self.symbol, symbol_bar)

    if len(self.feature_extractor.windows.get(self.symbol, [])) < self.feature_extractor.window_size + 1:
      return

    log_return = features["log_return"]
    rolling_mean = features["rolling_mean_log_return"]
    rolling_std = features["rolling_std_log_return"]
    rolling_zscore = features["rolling_zscore_close"]

    current_positions = self.ctx.get_positions()
    current_qty = current_positions.get(self.symbol, 0)
    norm_pos = current_qty / self.max_position

    nav = self.ctx.get_nav()
    balance = self.ctx.get_balance()
    norm_cash = balance / nav if nav > 0 else 1.0

    obs = np.array([[log_return, rolling_mean, rolling_std, rolling_zscore, norm_pos, norm_cash]], dtype=np.float32)

    if self.ort_session is not None:
      input_name = self.ort_session.get_inputs()[0].name
      ort_outs = self.ort_session.run(None, {input_name: obs})
      target_weight = float(ort_outs[0][0][0])
    else:
      if rolling_zscore > 1.0:
        target_weight = 0.5
      elif rolling_zscore < -1.0:
        target_weight = -0.5
      else:
        target_weight = 0.0

    order_qty = self.action_adapter.adapt_action(target_weight, current_qty, close, nav)

    if order_qty > 0:
      self.ctx.submit_order(self.symbol, abs(order_qty), "BUY", close)
    elif order_qty < 0:
      self.ctx.submit_order(self.symbol, abs(order_qty), "SELL", close)

  def on_order_status(self, order_response: Any) -> None:
    pass

