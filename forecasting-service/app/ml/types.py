"""Shared result shape for `sarima.py`/`prophet_model.py`'s forecast
functions, so `training.py` (backtest) and `inference_service.py`
(production forecasting) can consume either model type identically."""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


@dataclass(frozen=True)
class PointForecast:
    predicted: pd.Series
    lower: pd.Series
    upper: pd.Series
