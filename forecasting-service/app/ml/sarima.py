"""SARIMA fit/forecast, thin wrappers over `statsmodels`. `order`/
`seasonal_order` default to daily seasonality at 30-minute intervals - a
stated default (ADR-0021), not a tuned choice; weekly seasonality
(`s=336`) is deferred as computationally heavy at this data volume.
Backtest MAPE/WFA (`app/ml/backtest.py`) is what validates or invalidates
this default per queue, not an a priori claim of fitness.
"""

from __future__ import annotations

import pandas as pd
from statsmodels.tsa.statespace.sarimax import SARIMAX, SARIMAXResultsWrapper

from app.ml.types import PointForecast

DEFAULT_ORDER = (1, 1, 1)
DEFAULT_SEASONAL_ORDER = (1, 1, 1, 48)
# 80% interval, matching Prophet's default (`interval_width=0.8`) so the two
# model types' confidence bands are comparable rather than arbitrarily
# differently-scoped.
CONFIDENCE_ALPHA = 0.20


def fit_sarima(
    train: pd.Series,
    *,
    order: tuple[int, int, int] = DEFAULT_ORDER,
    seasonal_order: tuple[int, int, int, int] = DEFAULT_SEASONAL_ORDER,
) -> SARIMAXResultsWrapper:
    """`train` may contain `NaN` gaps - SARIMAX's state-space
    implementation handles missing endog values natively via the Kalman
    filter, so callers do not need to pre-impute."""
    model = SARIMAX(
        train,
        order=order,
        seasonal_order=seasonal_order,
        enforce_stationarity=False,
        enforce_invertibility=False,
    )
    return model.fit(disp=False)


def forecast_sarima(fitted: SARIMAXResultsWrapper, steps: int) -> PointForecast:
    forecast = fitted.get_forecast(steps=steps)
    conf_int = forecast.conf_int(alpha=CONFIDENCE_ALPHA)
    return PointForecast(
        predicted=pd.Series(forecast.predicted_mean),
        lower=pd.Series(conf_int.iloc[:, 0].to_numpy(), index=conf_int.index),
        upper=pd.Series(conf_int.iloc[:, 1].to_numpy(), index=conf_int.index),
    )
