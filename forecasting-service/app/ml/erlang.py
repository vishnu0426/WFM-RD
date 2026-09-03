"""Erlang C headcount conversion (ADR-0023). Pure math, no DB - `numpy`/
`pandas` not even needed here, just `math`. Erlang X/A (abandonment-aware)
is explicitly not implemented - see the ADR for why (no patience/abandon
data exists anywhere in this platform to parameterize it with).
"""

from __future__ import annotations

import math

# ADR-0023, Decision 2: guards the search loop in `required_agents` against
# pathological input (e.g. a corrupted near-zero AHT) looping indefinitely.
_MAX_AGENTS_SEARCH = 10_000


def erlang_c_probability(offered_load: float, agents: int) -> float:
    """Probability an arriving call must wait at all (Erlang C), via the
    standard recursive Erlang-B formula converted to Erlang C - `O(agents)`,
    no factorials, no overflow for any realistic `agents`."""
    if offered_load <= 0:
        return 0.0
    if agents <= 0:
        return 1.0
    if agents <= offered_load:
        # An unstable system (agents can't keep up with offered load) -
        # every call eventually waits.
        return 1.0

    erlang_b = 1.0
    for k in range(1, agents + 1):
        erlang_b = (offered_load * erlang_b) / (k + offered_load * erlang_b)

    denominator = 1 - (offered_load / agents) * (1 - erlang_b)
    if denominator <= 0:
        return 1.0
    return erlang_b / denominator


def service_level(
    offered_load: float, agents: int, aht_seconds: float, target_answer_seconds: float
) -> float:
    """Fraction of calls answered within `target_answer_seconds`, given
    `agents` staffed against `offered_load` Erlangs at `aht_seconds` average
    handle time."""
    if agents <= offered_load:
        return 0.0
    wait_probability = erlang_c_probability(offered_load, agents)
    return 1 - wait_probability * math.exp(
        -(agents - offered_load) * (target_answer_seconds / aht_seconds)
    )


def required_agents(
    *,
    volume: float,
    aht_seconds: float,
    interval_seconds: float,
    target_service_level: float,
    target_answer_seconds: float,
    max_occupancy: float,
) -> int:
    """Smallest integer agent count clearing *both* the service-level target
    and the max-occupancy cap (ADR-0023, Decision 2). Returns 0 for zero/
    negative volume (nothing to staff for)."""
    if volume <= 0 or aht_seconds <= 0:
        return 0

    offered_load = (volume * aht_seconds) / interval_seconds  # Erlangs
    agents = max(1, math.floor(offered_load) + 1)

    while agents <= _MAX_AGENTS_SEARCH:
        occupancy = offered_load / agents
        sl = service_level(offered_load, agents, aht_seconds, target_answer_seconds)
        if sl >= target_service_level and occupancy <= max_occupancy:
            return agents
        agents += 1

    raise ValueError(
        f"required_agents did not converge within {_MAX_AGENTS_SEARCH} agents "
        f"(offered_load={offered_load!r}) - check for corrupted input (e.g. near-zero AHT)"
    )


def required_headcount(
    *,
    volume: float | None,
    aht_seconds: float | None,
    shrinkage: float,
    interval_seconds: float,
    target_service_level: float,
    target_answer_seconds: float,
    max_occupancy: float,
) -> float | None:
    """Shrinkage-adjusted headcount - `None` if volume/AHT aren't available
    to compute from at all (distinct from a legitimate zero-volume interval,
    which returns `0.0`)."""
    if volume is None or aht_seconds is None:
        return None
    agents = required_agents(
        volume=volume,
        aht_seconds=aht_seconds,
        interval_seconds=interval_seconds,
        target_service_level=target_service_level,
        target_answer_seconds=target_answer_seconds,
        max_occupancy=max_occupancy,
    )
    if agents == 0:
        return 0.0
    # A shrinkage of 100%+ is nonsensical (would imply infinite headcount) -
    # callers are expected to have already applied ADR-0023's fallback chain
    # before reaching here, but this guards against a corrupted value rather
    # than dividing by zero/negative.
    effective_shrinkage = shrinkage if 0 <= shrinkage < 1 else 0.30
    return agents / (1 - effective_shrinkage)
