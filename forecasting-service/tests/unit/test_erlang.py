"""Erlang C math (ADR-0023) - pure, no DB, no `ray`/`mlflow`. Cross-checked
against an independent direct-summation (log-space, to avoid overflow)
reference implementation of the textbook Erlang C formula, not just
self-consistency - a genuine correctness check of the recursive Erlang-B-
based implementation `app/ml/erlang.py` actually uses.
"""

from __future__ import annotations

import math

import pytest

from app.ml.erlang import erlang_c_probability, required_agents, required_headcount, service_level


def _reference_erlang_c(offered_load: float, agents: int) -> float:
    """Direct textbook Erlang C formula, computed in log-space to avoid
    factorial overflow - independent of the recursive Erlang-B method
    `erlang_c_probability` actually uses, so agreement between the two is a
    real correctness signal, not a tautology."""
    if offered_load <= 0:
        return 0.0
    if agents <= offered_load:
        return 1.0
    log_terms = [k * math.log(offered_load) - math.lgamma(k + 1) for k in range(agents)]
    max_log = max(log_terms)
    log_sum_lower = max_log + math.log(sum(math.exp(t - max_log) for t in log_terms))

    log_top = agents * math.log(offered_load) - math.lgamma(agents + 1)
    log_top_scaled = log_top - math.log(1 - offered_load / agents)

    m = max(log_sum_lower, log_top_scaled)
    log_denominator = m + math.log(math.exp(log_sum_lower - m) + math.exp(log_top_scaled - m))
    return math.exp(log_top_scaled - log_denominator)


@pytest.mark.parametrize("offered_load", [1.0, 5.0, 10.0, 16.6667, 50.0, 100.0])
def test_erlang_c_matches_an_independent_reference_implementation(offered_load: float) -> None:
    for agents in range(int(offered_load) + 1, int(offered_load) + 40):
        mine = erlang_c_probability(offered_load, agents)
        reference = _reference_erlang_c(offered_load, agents)
        assert mine == pytest.approx(reference, abs=1e-9)


def test_erlang_c_probability_is_zero_for_zero_offered_load() -> None:
    assert erlang_c_probability(0.0, 10) == 0.0


def test_erlang_c_probability_is_one_when_agents_cannot_keep_up() -> None:
    assert erlang_c_probability(10.0, 5) == 1.0
    assert erlang_c_probability(10.0, 10) == 1.0


def test_erlang_c_probability_is_monotonically_decreasing_in_agents() -> None:
    previous = 1.0
    for agents in range(11, 60):
        probability = erlang_c_probability(10.0, agents)
        assert probability <= previous + 1e-12
        previous = probability


def test_service_level_is_zero_when_agents_cannot_keep_up() -> None:
    assert service_level(10.0, 10, aht_seconds=300, target_answer_seconds=20) == 0.0


def test_service_level_increases_with_more_agents() -> None:
    previous = -1.0
    for agents in range(11, 40):
        sl = service_level(10.0, agents, aht_seconds=300, target_answer_seconds=20)
        assert sl >= previous
        previous = sl
    assert previous > 0.99  # plenty of agents should approach 100% service level


def test_required_agents_is_zero_for_zero_volume() -> None:
    assert (
        required_agents(
            volume=0,
            aht_seconds=300,
            interval_seconds=1800,
            target_service_level=0.8,
            target_answer_seconds=20,
            max_occupancy=0.85,
        )
        == 0
    )


def test_required_agents_actually_clears_both_constraints() -> None:
    from app.ml.erlang import service_level as _service_level

    volume, aht_seconds, interval_seconds = 100, 300, 1800
    target_service_level, target_answer_seconds, max_occupancy = 0.8, 20, 0.85

    agents = required_agents(
        volume=volume,
        aht_seconds=aht_seconds,
        interval_seconds=interval_seconds,
        target_service_level=target_service_level,
        target_answer_seconds=target_answer_seconds,
        max_occupancy=max_occupancy,
    )
    offered_load = (volume * aht_seconds) / interval_seconds

    assert _service_level(offered_load, agents, aht_seconds, target_answer_seconds) >= target_service_level
    assert offered_load / agents <= max_occupancy
    # one fewer agent must fail at least one constraint (agents is *minimal*)
    if agents > 1:
        sl_below = _service_level(offered_load, agents - 1, aht_seconds, target_answer_seconds)
        occupancy_below = offered_load / (agents - 1)
        assert sl_below < target_service_level or occupancy_below > max_occupancy


def test_required_agents_raises_on_pathological_input_rather_than_hanging() -> None:
    with pytest.raises(ValueError, match="did not converge"):
        required_agents(
            volume=1_000_000_000,
            aht_seconds=1,
            interval_seconds=1,
            target_service_level=0.999999,
            target_answer_seconds=1,
            max_occupancy=0.01,
        )


def test_required_headcount_divides_by_one_minus_shrinkage() -> None:
    no_shrinkage = required_headcount(
        volume=100,
        aht_seconds=300,
        shrinkage=0.0,
        interval_seconds=1800,
        target_service_level=0.8,
        target_answer_seconds=20,
        max_occupancy=0.85,
    )
    with_shrinkage = required_headcount(
        volume=100,
        aht_seconds=300,
        shrinkage=0.3,
        interval_seconds=1800,
        target_service_level=0.8,
        target_answer_seconds=20,
        max_occupancy=0.85,
    )
    assert no_shrinkage is not None and with_shrinkage is not None
    assert with_shrinkage == pytest.approx(no_shrinkage / 0.7)


def test_required_headcount_is_none_when_volume_or_aht_is_missing() -> None:
    assert (
        required_headcount(
            volume=None,
            aht_seconds=300,
            shrinkage=0.3,
            interval_seconds=1800,
            target_service_level=0.8,
            target_answer_seconds=20,
            max_occupancy=0.85,
        )
        is None
    )
    assert (
        required_headcount(
            volume=100,
            aht_seconds=None,
            shrinkage=0.3,
            interval_seconds=1800,
            target_service_level=0.8,
            target_answer_seconds=20,
            max_occupancy=0.85,
        )
        is None
    )


def test_required_headcount_guards_against_nonsensical_shrinkage() -> None:
    """A shrinkage >= 100% (or negative) is nonsensical - falls back to the
    30% platform default rather than dividing by zero/negative."""
    result = required_headcount(
        volume=100,
        aht_seconds=300,
        shrinkage=1.5,
        interval_seconds=1800,
        target_service_level=0.8,
        target_answer_seconds=20,
        max_occupancy=0.85,
    )
    expected = required_headcount(
        volume=100,
        aht_seconds=300,
        shrinkage=0.30,
        interval_seconds=1800,
        target_service_level=0.8,
        target_answer_seconds=20,
        max_occupancy=0.85,
    )
    assert result == expected
