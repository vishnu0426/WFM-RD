"""Multi-skill routing simulation - the queueing-engine gap Erlang C can't
close on its own. `erlang.py` (ADR-0023) assumes one dedicated,
single-skill queue; it has no way to represent an agent who can serve more
than one, so a tenant with e.g. Billing/English/Tech-Tier-2 queues and
cross-trained agents gets a `HeadcountAllocation` that's just a fixed
percentage split of one queue's own independent Erlang C number - it never
credits the efficiency a shared, cross-skilled pool actually buys.

No closed-form multi-skill Erlang solution exists for an arbitrary skill
matrix (closed forms only exist for restrictive special cases, e.g.
fully-symmetric "N-design" matrices - this is well-documented queueing-
theory territory, not an oversight), so this uses discrete-event simulation
instead: run one interval forward with randomized Poisson arrivals per
queue and exponential service times, route each call to an available
capable agent, and measure the service level actually achieved.
`required_headcount_multiskill` wraps this in a marginal-allocation search
(add one agent at a time to whichever capable group most needs it) to find
the minimum headcount per group that clears every queue's service-level
target simultaneously.

Known gaps, stated plainly rather than left for someone to discover the
hard way:

- No `max_occupancy` cap - this stops as soon as every queue's
  service-level target is met, the same way `required_agents` would if
  called with `max_occupancy=1.0`. A caller that cares about occupancy,
  not just service level, needs to apply its own cap on top of this
  module's output for now.
- The marginal-allocation search is forward-only: each step adds one
  agent, never removes or re-homes one already placed. It reliably finds
  the pooling win when a queue's *only* route to coverage is a shared
  group (proven in `test_multiskill_simulation.py`), but in a topology
  where a full dedicated team is *also* an option for every queue, the
  search can converge on an all-dedicated-looking answer even when a
  smaller, more heavily pooled allocation exists - it has no mechanism to
  discover "trade two specialists for one generalist" after the fact.
  Getting real optimization guarantees for an arbitrary mixed topology
  would need a fundamentally different method (e.g. an LP relaxation over
  candidate allocations), not a bigger tweak to this search.
"""

from __future__ import annotations

import heapq
import itertools
import random
from dataclasses import dataclass

_ARRIVAL = 0
_AGENT_FREE = 1

# Marginal-allocation search cap (`required_headcount_multiskill`) - same
# role as `erlang.py`'s `_MAX_AGENTS_SEARCH`: guards against pathological
# input (e.g. a skill matrix that technically covers a queue but with far
# too little combined capacity to ever clear its target) looping forever.
_MAX_TOTAL_AGENTS = 2_000

# `_simulate_once` runs a burn-in period before the measured interval so the
# system reaches quasi-steady-state before anything is counted - a queue
# simulated from a cold, empty start (every agent idle at t=0) is
# systematically *more* optimistic than Erlang C's own steady-state formula
# expects, and that bias gets worse the higher the utilization (verified
# empirically: at 97% utilization, an unwarmed sim reports ~0.85 service
# level for a headcount Erlang C's closed form says only clears ~0.21 - not
# noise, a real cold-start artifact). Erlang C itself implicitly assumes
# each interval is its own steady state (that's the whole premise of
# per-interval Erlang C staffing, ADR-0023), so this burn-in makes the
# simulation consistent with that same assumption rather than measuring a
# transient. 40x the slowest queue's AHT was enough to converge onto Erlang
# C's own answer within a percentage point or two even at 97% utilization
# (empirically probed, not derived); cheap to make generous since burn-in
# calls only add simulated event volume, not wall-clock-bound work.
_BURN_IN_AHT_MULTIPLIER = 40


@dataclass(frozen=True)
class QueueLoad:
    """One queue's Erlang-C-equivalent inputs for one interval - the same
    shape `erlang.py`'s `required_agents` takes, but per queue rather than
    per whole org unit, since a multi-skill simulation needs every
    concurrently-staffed queue's own load and target at once."""

    queue_id: str
    volume: float
    aht_seconds: float
    target_service_level: float
    target_answer_seconds: float
    interval_seconds: float


@dataclass(frozen=True)
class AgentGroup:
    """One staffing pool - every agent in it holds exactly the skills in
    `skills` (the set of `queue_id`s they can serve). A single-skill
    dedicated team is just a group whose `skills` is one queue_id; a
    cross-trained pool is a group whose `skills` spans several."""

    group_id: str
    skills: frozenset[str]


@dataclass(frozen=True)
class SimulationResult:
    service_level_by_queue: dict[str, float]
    offered_by_queue: dict[str, int]
    answered_within_target_by_queue: dict[str, int]


def _generate_arrivals(
    volume: float, interval_seconds: float, duration: float, rng: random.Random
) -> list[float]:
    """Poisson arrival process over `[0, duration)` at the rate implied by
    `volume` calls per `interval_seconds` - the same statistical assumption
    `erlang_c_probability` is implicitly built on (M/M/c), just realized as
    actual random arrivals instead of folded into a closed-form probability.
    `duration` is normally `interval_seconds` plus the burn-in window, not
    `interval_seconds` itself - see `_BURN_IN_AHT_MULTIPLIER`."""
    if volume <= 0 or interval_seconds <= 0 or duration <= 0:
        return []
    rate = volume / interval_seconds
    arrivals: list[float] = []
    t = 0.0
    while True:
        t += rng.expovariate(rate)
        if t > duration:
            return arrivals
        arrivals.append(t)


def _burn_in_seconds(queues: list[QueueLoad]) -> float:
    active_aht = [q.aht_seconds for q in queues if q.volume > 0 and q.aht_seconds > 0]
    if not active_aht:
        return 0.0
    return _BURN_IN_AHT_MULTIPLIER * max(active_aht)


def _capable_groups(groups: list[AgentGroup], queue_id: str) -> list[AgentGroup]:
    """Specialists (fewest skills) before generalists - preserves
    cross-skilled capacity for the queues only a generalist can reach,
    rather than burning it on a queue a dedicated group could also serve.
    `group_id` breaks ties deterministically."""
    return sorted((g for g in groups if queue_id in g.skills), key=lambda g: (len(g.skills), g.group_id))


def _simulate_once(
    queues: list[QueueLoad],
    groups: list[AgentGroup],
    headcount_by_group: dict[str, int],
    rng: random.Random,
) -> SimulationResult:
    queues_by_id = {q.queue_id: q for q in queues}
    burn_in = _burn_in_seconds(queues)
    counter = itertools.count()
    # (time, sequence, event_kind, payload) - `sequence` is a pure tiebreaker
    # so heapq never has to compare `payload` (a str for both event kinds
    # here, but keeping the tuple order-safe regardless of payload type).
    events: list[tuple[float, int, int, str]] = []
    for q in queues:
        duration = burn_in + q.interval_seconds
        for arrival_time in _generate_arrivals(q.volume, q.interval_seconds, duration, rng):
            heapq.heappush(events, (arrival_time, next(counter), _ARRIVAL, q.queue_id))

    available = {g.group_id: headcount_by_group.get(g.group_id, 0) for g in groups}
    wait_lists: dict[str, list[float]] = {q.queue_id: [] for q in queues}
    offered = {q.queue_id: 0 for q in queues}
    answered_within = {q.queue_id: 0 for q in queues}

    def in_measurement_window(queue_id: str, arrival_time: float) -> bool:
        q = queues_by_id[queue_id]
        return burn_in <= arrival_time < burn_in + q.interval_seconds

    def start_service(group_id: str, queue_id: str, arrival_time: float, now: float) -> None:
        available[group_id] -= 1
        q = queues_by_id[queue_id]
        duration = rng.expovariate(1.0 / q.aht_seconds) if q.aht_seconds > 0 else 0.0
        heapq.heappush(events, (now + duration, next(counter), _AGENT_FREE, group_id))
        if in_measurement_window(queue_id, arrival_time) and (now - arrival_time) <= q.target_answer_seconds:
            answered_within[queue_id] += 1

    while events:
        time, _, kind, payload = heapq.heappop(events)
        if kind == _ARRIVAL:
            queue_id = payload
            if in_measurement_window(queue_id, time):
                offered[queue_id] += 1
            assigned = next((g for g in _capable_groups(groups, queue_id) if available[g.group_id] > 0), None)
            if assigned is not None:
                start_service(assigned.group_id, queue_id, time, time)
            else:
                wait_lists[queue_id].append(time)
        else:
            group_id = payload
            available[group_id] += 1
            group = next(g for g in groups if g.group_id == group_id)
            servable = [qid for qid in group.skills if wait_lists.get(qid)]
            if servable:
                # Oldest-waiting call first, across every queue this group can reach.
                queue_id = min(servable, key=lambda qid: wait_lists[qid][0])
                arrival_time = wait_lists[queue_id].pop(0)
                start_service(group_id, queue_id, arrival_time, time)

    return SimulationResult(
        service_level_by_queue={
            q.queue_id: (answered_within[q.queue_id] / offered[q.queue_id])
            if offered[q.queue_id] > 0
            else 1.0
            for q in queues
        },
        offered_by_queue=offered,
        answered_within_target_by_queue=answered_within,
    )


def simulate(
    queues: list[QueueLoad],
    groups: list[AgentGroup],
    headcount_by_group: dict[str, int],
    *,
    replications: int = 20,
    seed: int = 0,
) -> SimulationResult:
    """Averages `replications` independent discrete-event runs - a single
    run's service level for a low-volume queue can swing by double-digit
    percentage points run to run, since (unlike Erlang C) no closed-form
    expression exists here to compute the true steady-state value directly."""
    if replications <= 0:
        raise ValueError("replications must be positive")
    totals_offered = {q.queue_id: 0 for q in queues}
    totals_answered = {q.queue_id: 0 for q in queues}
    for i in range(replications):
        result = _simulate_once(queues, groups, headcount_by_group, random.Random(seed * 1_000_003 + i))
        for q in queues:
            totals_offered[q.queue_id] += result.offered_by_queue[q.queue_id]
            totals_answered[q.queue_id] += result.answered_within_target_by_queue[q.queue_id]
    return SimulationResult(
        service_level_by_queue={
            q.queue_id: (totals_answered[q.queue_id] / totals_offered[q.queue_id])
            if totals_offered[q.queue_id] > 0
            else 1.0
            for q in queues
        },
        offered_by_queue=totals_offered,
        answered_within_target_by_queue=totals_answered,
    )


def _total_shortfall(result: SimulationResult, active_queues: list[QueueLoad]) -> float:
    return sum(
        max(0.0, q.target_service_level - result.service_level_by_queue[q.queue_id]) for q in active_queues
    )


def required_headcount_multiskill(
    queues: list[QueueLoad],
    groups: list[AgentGroup],
    *,
    search_replications: int = 8,
    seed: int = 0,
) -> dict[str, int]:
    """Marginal-allocation search: starting from zero agents everywhere,
    repeatedly simulate the current staffing and, if any queue is still
    short of its target, try adding one agent to each group capable of
    reaching an under-target queue and keep whichever candidate cuts total
    shortfall the most - not just "the most specialized group for the
    worst queue" (`_capable_groups`'s own ordering), since that policy
    never has a reason to ever staff a cross-skilled pool at all: a
    dedicated specialist is always "more specialized" than a generalist for
    its own queue, so a purely specialist-first rule would starve the flex
    pool of headcount even in the textbook case where pooling is strictly
    better (verified in `test_multiskill_simulation.py` - a naive
    specialist-first version of this search converges to exactly the
    independent-Erlang-C total, 0 credit to the flex pool, in exactly that
    scenario). Each candidate trial reuses the same seed as every other
    candidate this iteration (common random numbers) so the comparison
    isolates the effect of *where* the next agent goes, not which random
    call stream a candidate happened to get.

    Not guaranteed globally optimal (no such guarantee exists for an
    arbitrary skill matrix without exhaustive search - the same honest
    framing ADR-0023 already applies to Erlang C's own known limitations),
    but a deterministic, defensible incremental policy that converges for
    any coverable skill matrix.
    """
    active_queues = [q for q in queues if q.volume > 0]
    for q in active_queues:
        if not any(q.queue_id in g.skills for g in groups):
            raise ValueError(f"No agent group can serve queue '{q.queue_id}' - staffing it is impossible.")

    headcount = {g.group_id: 0 for g in groups}
    for total in range(_MAX_TOTAL_AGENTS):
        iteration_seed = seed + total
        result = simulate(queues, groups, headcount, replications=search_replications, seed=iteration_seed)
        current_shortfall = _total_shortfall(result, active_queues)
        if current_shortfall <= 0:
            return headcount

        # A plain `set` here would make `max()`'s tie-break below depend on
        # string hash order, which Python randomizes per process - the same
        # `seed` could then pick a different queue (and cascade to a
        # different final headcount) on every run. Sorting by `queue_id`
        # fixes a single deterministic order regardless of hash seed.
        short_queues = sorted(
            (q for q in active_queues if result.service_level_by_queue[q.queue_id] < q.target_service_level),
            key=lambda q: q.queue_id,
        )
        short_queue_ids = frozenset(q.queue_id for q in short_queues)
        candidates = [g for g in groups if g.skills & short_queue_ids]
        best_group_id, best_shortfall = None, current_shortfall
        for g in candidates:
            trial_headcount = dict(headcount)
            trial_headcount[g.group_id] += 1
            trial_result = simulate(
                queues, groups, trial_headcount, replications=search_replications, seed=iteration_seed
            )
            trial_shortfall = _total_shortfall(trial_result, active_queues)
            if trial_shortfall < best_shortfall:
                best_shortfall, best_group_id = trial_shortfall, g.group_id

        if best_group_id is None:
            # No single added agent measurably helped above this replication
            # count's noise floor (common far from convergence, where one
            # more agent out of the dozens still needed barely moves the
            # estimate) - fall back to the most specialized group for the
            # single worst queue, same tiebreak `_capable_groups` always
            # uses, rather than stalling. `q.queue_id` as the key's second
            # element breaks exact shortfall ties deterministically.
            worst_queue = max(
                short_queues,
                key=lambda q: (
                    q.target_service_level - result.service_level_by_queue[q.queue_id],
                    q.queue_id,
                ),
            )
            best_group_id = _capable_groups(groups, worst_queue.queue_id)[0].group_id
        headcount[best_group_id] += 1

    raise ValueError(
        f"required_headcount_multiskill did not converge within {_MAX_TOTAL_AGENTS} total agents."
    )
