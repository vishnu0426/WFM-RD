"""LightGBM fit/forecast (ADR-0022, Decision 1/2). Calendar-features-only -
no lag features, no external features (marketing spend/campaign flags/
weather) - since this platform ingests none of the latter anywhere yet.
Confidence intervals come from quantile regression (three `Booster`s per
candidate: alpha 0.1/0.5/0.9), matching SARIMA/Prophet's 80% interval width.
"""

from __future__ import annotations

import lightgbm as lgb
import numpy as np
import pandas as pd

from app.ml.types import PointForecast

_NUM_BOOST_ROUND = 100
_QUANTILES = {"lower": 0.1, "point": 0.5, "upper": 0.9}


def _build_features(index: pd.DatetimeIndex) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "day_of_week": index.dayofweek,
            "hour": index.hour,
            "minute_of_day": index.hour * 60 + index.minute,
            "is_weekend": (index.dayofweek >= 5).astype(int),
        },
        index=index,
    )


def fit_lightgbm(train: pd.Series) -> dict[str, lgb.Booster]:
    """`train` may contain `NaN` gaps - dropped before fitting (LightGBM,
    like Prophet, trains on the rows it has rather than needing a regular
    grid)."""
    clean = train.dropna()
    features = _build_features(pd.DatetimeIndex(clean.index))

    boosters: dict[str, lgb.Booster] = {}
    for name, alpha in _QUANTILES.items():
        dataset = lgb.Dataset(features, label=clean.to_numpy())
        params = {"objective": "quantile", "alpha": alpha, "verbosity": -1}
        boosters[name] = lgb.train(params, dataset, num_boost_round=_NUM_BOOST_ROUND)
    return boosters


def forecast_lightgbm(boosters: dict[str, lgb.Booster], future_index: pd.DatetimeIndex) -> PointForecast:
    features = _build_features(future_index)
    predicted = pd.Series(boosters["point"].predict(features), index=future_index)
    lower = pd.Series(boosters["lower"].predict(features), index=future_index)
    upper = pd.Series(boosters["upper"].predict(features), index=future_index)

    # Quantile regressors are fit independently, so lower/upper can cross
    # the point estimate on small/noisy data - clipped so the interval is
    # always internally consistent (lower <= predicted <= upper), the same
    # invariant SARIMA/Prophet's own conf_int()/yhat_lower/yhat_upper hold
    # by construction.
    lower = pd.Series(np.minimum(lower, predicted), index=future_index)
    upper = pd.Series(np.maximum(upper, predicted), index=future_index)

    return PointForecast(predicted=predicted, lower=lower, upper=upper)
