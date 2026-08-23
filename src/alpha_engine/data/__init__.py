"""Historical market data and pipeline management module."""

from src.alpha_engine.data.adjuster import CorporateActionAdjuster
from src.alpha_engine.data.downloader import BaseDataFetcher, CSVDataFetcher, SyntheticDataGenerator
from src.alpha_engine.data.schema import (
    ADJ_CLOSE_COL,
    CANONICAL_SCHEMA,
    CLOSE_COL,
    DIVIDEND_COL,
    HIGH_COL,
    LOW_COL,
    OPEN_COL,
    SPLIT_FACTOR_COL,
    SYMBOL_COL,
    TIMESTAMP_COL,
    VOLUME_COL,
    validate_and_normalize_schema,
)
from src.alpha_engine.data.storage import MarketDataManager
from src.alpha_engine.data.validator import DataIntegrityValidator, ValidationError

__all__ = [
    "TIMESTAMP_COL",
    "SYMBOL_COL",
    "OPEN_COL",
    "HIGH_COL",
    "LOW_COL",
    "CLOSE_COL",
    "VOLUME_COL",
    "ADJ_CLOSE_COL",
    "DIVIDEND_COL",
    "SPLIT_FACTOR_COL",
    "CANONICAL_SCHEMA",
    "validate_and_normalize_schema",
    "DataIntegrityValidator",
    "ValidationError",
    "CorporateActionAdjuster",
    "BaseDataFetcher",
    "SyntheticDataGenerator",
    "CSVDataFetcher",
    "MarketDataManager",
]
