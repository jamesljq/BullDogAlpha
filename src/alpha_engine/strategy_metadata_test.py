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
      self.assertTrue(bool(meta.philosophy_en), f"{strat_cls.__name__} missing English Philosophy")
      self.assertTrue(bool(meta.philosophy_zh), f"{strat_cls.__name__} missing Chinese Philosophy")
      self.assertTrue(bool(meta.mechanics_en), f"{strat_cls.__name__} missing English Mechanics")
      self.assertTrue(bool(meta.mechanics_zh), f"{strat_cls.__name__} missing Chinese Mechanics")
      self.assertTrue(bool(meta.suitable_regime_en), f"{strat_cls.__name__} missing English Suitable Regime")
      self.assertTrue(bool(meta.suitable_regime_zh), f"{strat_cls.__name__} missing Chinese Suitable Regime")
      self.assertTrue(bool(meta.risk_profile_en), f"{strat_cls.__name__} missing English Risk Profile")
      self.assertTrue(bool(meta.risk_profile_zh), f"{strat_cls.__name__} missing Chinese Risk Profile")
      self.assertIsInstance(meta.default_params, dict)
      self.assertIsInstance(meta.param_schemas, dict)
      self.assertTrue(len(meta.param_schemas) > 0, f"{strat_cls.__name__} must define parameter schemas")

      for p_key, p_schema in meta.param_schemas.items():
        self.assertIn("name", p_schema)
        self.assertIn("default_value", p_schema)
        self.assertIn("valid_range", p_schema)
        self.assertIn("description_en", p_schema)
        self.assertIn("description_zh", p_schema)

      # Check serialization
      d = meta.to_dict()
      self.assertEqual(d["id"], meta.id)
      self.assertEqual(d["name"], meta.name)
      self.assertEqual(d["philosophy_en"], meta.philosophy_en)
      self.assertEqual(d["philosophy_zh"], meta.philosophy_zh)


if __name__ == "__main__":
  unittest.main()

