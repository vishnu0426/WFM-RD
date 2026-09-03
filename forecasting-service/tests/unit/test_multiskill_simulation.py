"""Multi-skill routing simulation - pure, no DB. The two properties that
matter most: (1) a single-queue/single-group setup should behave like a
plain M/M/c queue (cross-checked loosely against `erlang.py`'s own
`required_agents`, since both model the same statistical process), and
(2) a shared cross-skilled pool should require *less* total headcount than
the naive sum of independent per-queue Erlang C numbers - that efficiency
gain is the entire point of this module existing.
"""

from __future__ import annotations

from app.ml.erlang import required_agents
from app.ml.multiskill_simulation import (
    AgentGroup,
    QueueLoad,
    required_headcount_multiskill,
    simulate,
)


def _queue(queue_id: str, *, volume: float, aht_seconds: float = 240.0) -> QueueLoad:
    return QueueLoad(
        queue_id=queue_id,
        volume=volume,
        aht_seconds=aht_seconds,
        target_service_level=0.80,
        target_answer_seconds=20,
        interval_seconds=900.0,
    )


def test_simulate_is_deterministic_for_a_fixed_seed() -> None:
    queues = [_queue("billing", volume=40)]
    groups = [AgentGroup("billing_team", frozenset({"billing"}))]
    first = simulate(queues, groups, {"billing_team": 10}, seed=42)
    second = simulate(queues, groups, {"billing_team": 10}, seed=42)
    assert first.service_level_by_queue == second.service_level_by_queue
    assert first.offered_by_queue == second.offered_by_queue


def test_zero_headcount_means_nobody_is_answered_within_target() -> None:
    queues = [_queue("billing", volume=40)]
    groups = [AgentGroup("billing_team", frozenset({"billing"}))]
    result = simulate(queues, groups, {"billing_team": 0}, seed=1)
    assert result.offered_by_queue["billing"] > 0
    assert result.service_level_by_queue["billing"] == 0.0


def test_service_level_is_monotonically_non_decreasing_in_headcount() -> None:
    queues = [_queue("billing", volume=60)]
    groups = [AgentGroup("billing_team", frozenset({"billing"}))]
    previous = -1.0
    for headcount in range(5, 25):
        result = simulate(queues, groups, {"billing_team": headcount}, replications=15, seed=7)
        current = result.service_level_by_queue["billing"]
        assert current >= previous - 0.05  # small Monte Carlo slack, not a strict guarantee
        previous = current


def test_single_queue_single_group_is_in_the_right_ballpark_vs_erlang_c() -> None:
    """Not an exact match (the simulation's random service times/Poisson
    arrivals are a noisier estimate than Erlang C's closed form), but the
    two should agree on the achievable answer to within a few agents -
    `max_occupancy=1.0` here so Erlang C is chasing the same single
    constraint (service level only) this module's search actually chases;
    see the module's own doc comment for why an occupancy cap isn't
    modeled here yet."""
    volume, aht_seconds, interval_seconds = 80.0, 240.0, 900.0
    erlang_answer = required_agents(
        volume=volume,
        aht_seconds=aht_seconds,
        interval_seconds=interval_seconds,
        target_service_level=0.80,
        target_answer_seconds=20,
        max_occupancy=1.0,
    )

    queues = [
        QueueLoad(
            queue_id="billing",
            volume=volume,
            aht_seconds=aht_seconds,
            target_service_level=0.80,
            target_answer_seconds=20,
            interval_seconds=interval_seconds,
        )
    ]
    groups = [AgentGroup("billing_team", frozenset({"billing"}))]
    simulated_answer = required_headcount_multiskill(queues, groups, search_replications=15, seed=3)[
        "billing_team"
    ]
    assert abs(simulated_answer - erlang_answer) <= 4


def test_pooling_multiple_queues_needs_less_total_headcount_than_independent_erlang_c() -> None:
    """The core value proposition: three queues, each independently staffed,
    vs. the same three queues served by one fully cross-skilled pool. The
    pooled answer must use strictly fewer total agents - that's the
    efficiency gain independent per-queue Erlang C (and the platform's
    existing `HeadcountAllocation` percentage split) can't see at all."""
    queue_defs = [("billing", 30.0), ("tech", 30.0), ("english", 30.0)]
    interval_seconds = 900.0
    aht_seconds = 240.0

    independent_total = sum(
        required_agents(
            volume=volume,
            aht_seconds=aht_seconds,
            interval_seconds=interval_seconds,
            target_service_level=0.80,
            target_answer_seconds=20,
            # No occupancy cap - keeps this a fair comparison against the
            # simulation, which doesn't model one either (see
            # `multiskill_simulation.py`'s own doc comment); otherwise part
            # of the "pooling wins" gap would just be the occupancy cap
            # mismatch, not pooling itself.
            max_occupancy=1.0,
        )
        for _queue_id, volume in queue_defs
    )

    queues = [
        QueueLoad(
            queue_id=queue_id,
            volume=volume,
            aht_seconds=aht_seconds,
            target_service_level=0.80,
            target_answer_seconds=20,
            interval_seconds=interval_seconds,
        )
        for queue_id, volume in queue_defs
    ]
    pooled_group = [AgentGroup("cross_skilled_pool", frozenset({"billing", "tech", "english"}))]
    pooled_headcount = required_headcount_multiskill(queues, pooled_group, search_replications=15, seed=11)
    pooled_total = sum(pooled_headcount.values())

    assert pooled_total < independent_total


def test_pooling_a_small_trickle_queue_beats_giving_it_a_dedicated_team() -> None:
    """The classic real-world motivation for cross-training: a low-volume
    queue that would need its own minimum-one-agent dedicated team is
    cheaper to serve by folding it into a shared pool with a bigger queue -
    the trickle traffic gets absorbed by capacity that's mostly there for
    the big queue anyway, instead of needing its own dedicated headcount.

    This module's marginal-allocation search is forward-only (it only ever
    adds agents, never trades a specialist back out in favor of pooled
    capacity - see the module's own doc comment), so it does not reliably
    find a pooling win in every mixed dedicated+flex topology; this
    specific shape (a queue with no dedicated-team option at all) is one
    where the win is real and consistent, not one where the search happens
    to stumble onto it."""
    interval_seconds = 900.0
    aht_seconds = 240.0
    queue_defs = [("big", 60.0), ("trickle", 5.0)]

    independent_total = sum(
        required_agents(
            volume=volume,
            aht_seconds=aht_seconds,
            interval_seconds=interval_seconds,
            target_service_level=0.80,
            target_answer_seconds=20,
            max_occupancy=1.0,
        )
        for _queue_id, volume in queue_defs
    )

    queues = [
        QueueLoad(
            queue_id=queue_id,
            volume=volume,
            aht_seconds=aht_seconds,
            target_service_level=0.80,
            target_answer_seconds=20,
            interval_seconds=interval_seconds,
        )
        for queue_id, volume in queue_defs
    ]
    # No dedicated "trickle_team" - the only way to serve it is through the
    # shared pool, which also serves "big".
    groups = [
        AgentGroup("big_team", frozenset({"big"})),
        AgentGroup("flex_pool", frozenset({"big", "trickle"})),
    ]
    headcount = required_headcount_multiskill(queues, groups, search_replications=20, seed=17)

    assert sum(headcount.values()) < independent_total


def test_a_queue_with_no_capable_group_raises() -> None:
    queues = [_queue("orphan", volume=10)]
    groups = [AgentGroup("billing_team", frozenset({"billing"}))]
    try:
        required_headcount_multiskill(queues, groups)
    except ValueError as exc:
        assert "orphan" in str(exc)
    else:
        raise AssertionError("expected a ValueError for an unstaffable queue")


def test_zero_volume_queue_needs_no_headcount() -> None:
    queues = [_queue("quiet", volume=0)]
    groups = [AgentGroup("team", frozenset({"quiet"}))]
    headcount = required_headcount_multiskill(queues, groups)
    assert headcount["team"] == 0
