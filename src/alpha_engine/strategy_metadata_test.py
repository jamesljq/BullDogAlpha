"""Unit tests verifying strategy explainability metadata enforcement across all strategies."""

import unittest
from src.alpha_engine.strategies.base import BaseStrategy, StrategyMetadata
from src.alpha_engine.strategies.trend_strategy import TrendStrategy
from src.alpha_engine.strategies.mean_reversion_strategy import MeanReversionStrategy
from src.alpha_engine.strategies.stat_arb_strategy import StatArbStrategy
from src.alpha_engine.strategies.momentum_strategy import CrossSectionalMomentumStrategy
from src.alpha_engine.strategies.rl_strategy import RLStrategy


class StrategyMetadataTest(unittest.TestCase):
  """Validates that all alpha strategies implement rich explainability metadata."""

  def test_all_strategies_implement_explainability_metadata(self):
    strategy_classes = [
        TrendStrategy,
        MeanReversionStrategy,
        StatArbStrategy,
        CrossSectionalMomentumStrategy,
        RLStrategy,
    ]

    for strat_cls in strategy_classes:
      meta = strat_cls.get_metadata()
      self.assertIsInstance(meta, StrategyMetadata)
      self.assertTrue(bool(meta.id), f"{strat_cls.__name__} missing ID")
      self.assertTrue(bool(meta.name), f"{strat_cls.__name__} missing Name")
      self.assertTrue(bool(meta.category), f"{strat_cls.__name__} missing Category")
      self.assertTrue(bool(meta.philosophy), f"{strat_cls.__name__} missing Philosophy")
      self.assertTrue(bool(meta.mechanics), f"{strat_cls.__name__} missing Mechanics")
      self.assertTrue(bool(meta.suitable_regime), f"{strat_cls.__name__} missing Suitable Regime")
      self.assertTrue(bool(meta.risk_profile), f"{strat_cls.__name__} missing Risk Profile")
      self.assertIsInstance(meta.default_params, dict)
      self.assertIsInstance(meta.param_descriptions, dict)

      # Check serialization
      d = meta.to_dict()
      self.assertEqual(d["id"], meta.id)
      self.assertEqual(d["name"], meta.name)
      self.assertEqual(d["philosophy"], meta.philosophy)


if __name__ == "__main__":
  unittest.main()
