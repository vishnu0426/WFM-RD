"""Scenario assumption-override math (ADR-0024, Decision 1). Pure - no DB,
no model fitting. `volume_multiplier` is multiplicative; `aht_delta_seconds`/
`shrinkage_delta_pct` are additive - deltas, not replacements, so "what if
AHT goes up by 30 seconds" composes with whatever AHT the base run/
historical fallback already resolved to.
"""

from __future__ import annotations

from dataclasses import dataclass

_MIN_AHT_SECONDS = 0.01
_MAX_SHRINKAGE = 0.99


@dataclass(frozen=True)
class AssumptionOverrides:
    volume_multiplier: float = 1.0
    aht_delta_seconds: float = 0.0
    shrinkage_delta_pct: float = 0.0


@dataclass(frozen=True)
class AdjustedValues:
    volume: float | None
    aht_seconds: float | None
    shrinkage_pct: float | None


def apply_overrides(
    *,
    volume: float | None,
    aht_seconds: float | None,
    shrinkage_pct: float | None,
    overrides: AssumptionOverrides,
) -> AdjustedValues:
    """`aht_seconds`/`shrinkage_pct` are expected to already be *resolved*
    (a real value, own or historical-fallback - see ADR-0024, Decision 2),
    not raw possibly-`NULL` database columns - the caller resolves that
    before calling this, since this function has no DB access and no
    platform-default knowledge of its own."""
    adjusted_volume = None if volume is None else max(volume * overrides.volume_multiplier, 0.0)

    adjusted_aht = (
        None if aht_seconds is None else max(aht_seconds + overrides.aht_delta_seconds, _MIN_AHT_SECONDS)
    )

    adjusted_shrinkage = (
        None
        if shrinkage_pct is None
        else min(max(shrinkage_pct + overrides.shrinkage_delta_pct, 0.0), _MAX_SHRINKAGE)
    )

    return AdjustedValues(volume=adjusted_volume, aht_seconds=adjusted_aht, shrinkage_pct=adjusted_shrinkage)
