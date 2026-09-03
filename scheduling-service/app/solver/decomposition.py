"""§7.1/ADR-0061's decomposition strategy: split a large `SolveInput` into
independently-solvable per-site sub-problems, merging sites that share a
rare skill neither can locally cover on its own. Pure - no DB/HTTP
awareness, same posture as the rest of `app/solver/` - `app/worker.py`
solves each returned group and merges the results.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, replace

from app.solver.types import Employee, ShiftSlot, SolveInput

#: Below this employee count, decomposition is a deliberate no-op (ADR-0061
#: Decision 1) - every pre-Phase-7 job (and every existing test) is well
#: under this, so behavior is unchanged unless a job is genuinely large.
DECOMPOSITION_EMPLOYEE_THRESHOLD = 200


@dataclass(frozen=True)
class DecompositionGroup:
    group_id: str
    org_unit_ids: frozenset[uuid.UUID]
    solve_input: SolveInput


def decompose(solve_input: SolveInput) -> list[DecompositionGroup]:
    """Returns a single-element list (the input unchanged) whenever
    decomposition doesn't apply or isn't safe: below the employee
    threshold, fewer than two distinct shift sites, or *any* shift missing
    `org_unit_id` (decomposing on incomplete site information risks
    silently dropping that shift's coverage from every group - safer to
    not decompose at all than to guess)."""
    if len(solve_input.employees) <= DECOMPOSITION_EMPLOYEE_THRESHOLD:
        return [_single_group(solve_input)]
    if not solve_input.shifts or any(s.org_unit_id is None for s in solve_input.shifts):
        return [_single_group(solve_input)]

    site_ids = {s.org_unit_id for s in solve_input.shifts}
    assert all(site_id is not None for site_id in site_ids)  # narrowed by the check above
    if len(site_ids) < 2:
        return [_single_group(solve_input)]

    merged_sites = _merge_coupled_sites(solve_input, site_ids)  # type: ignore[arg-type]
    return _materialize_groups(solve_input, merged_sites)


def _single_group(solve_input: SolveInput) -> DecompositionGroup:
    org_unit_ids = frozenset(s.org_unit_id for s in solve_input.shifts if s.org_unit_id is not None)
    return DecompositionGroup(group_id="single", org_unit_ids=org_unit_ids, solve_input=solve_input)


def _merge_coupled_sites(
    solve_input: SolveInput, site_ids: set[uuid.UUID]
) -> dict[uuid.UUID, set[uuid.UUID]]:
    """Union-find (ADR-0061 Decision 2): for each skill required at two or
    more sites, if any of those sites' own home-employee pool can't locally
    cover its own requirement for that skill, every site sharing that
    requirement is merged into one group - conservative (a merged
    sub-problem's feasible region is a superset of the independent ones'),
    correct by construction, never a coordination pass patching shortfalls
    after the fact."""
    parent = {site: site for site in site_ids}

    def find(x: uuid.UUID) -> uuid.UUID:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: uuid.UUID, b: uuid.UUID) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    employees_by_site: dict[uuid.UUID, list[Employee]] = defaultdict(list)
    for e in solve_input.employees:
        if e.org_unit_id in site_ids:
            employees_by_site[e.org_unit_id].append(e)

    shifts_by_site: dict[uuid.UUID, list[ShiftSlot]] = defaultdict(list)
    for s in solve_input.shifts:
        shifts_by_site[s.org_unit_id].append(s)  # type: ignore[index]

    skill_sites: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    for s in solve_input.shifts:
        if s.required_skill_id is not None:
            skill_sites[s.required_skill_id].add(s.org_unit_id)  # type: ignore[arg-type]

    as_of = solve_input.date_range_start
    for skill_id, sites in skill_sites.items():
        if len(sites) < 2:
            continue
        insufficient = False
        for site in sites:
            required = sum(
                s.required_headcount for s in shifts_by_site[site] if s.required_skill_id == skill_id
            )
            qualified = sum(1 for e in employees_by_site[site] if e.has_skill(skill_id, as_of))
            if qualified < required:
                insufficient = True
                break
        if insufficient:
            ordered = sorted(sites, key=str)
            for a, b in zip(ordered, ordered[1:], strict=False):
                union(a, b)

    groups: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    for site in site_ids:
        groups[find(site)].add(site)
    return groups


def _materialize_groups(
    solve_input: SolveInput, groups: dict[uuid.UUID, set[uuid.UUID]]
) -> list[DecompositionGroup]:
    result: list[DecompositionGroup] = []
    for index, member_sites in enumerate(sorted(groups.values(), key=lambda s: sorted(str(x) for x in s))):
        group_employees = tuple(e for e in solve_input.employees if e.org_unit_id in member_sites)
        group_shifts = tuple(s for s in solve_input.shifts if s.org_unit_id in member_sites)
        group_employee_ids = {e.id for e in group_employees}
        group_fairness_history = {
            eid: count
            for eid, count in solve_input.fairness_history_counts.items()
            if eid in group_employee_ids
        }
        group_shift_ids = {s.id for s in group_shifts}
        group_locked_assignments = tuple(
            la for la in solve_input.locked_assignments if la.shift_id in group_shift_ids
        )
        group_input = replace(
            solve_input,
            employees=group_employees,
            shifts=group_shifts,
            fairness_history_counts=group_fairness_history,
            locked_assignments=group_locked_assignments,
        )
        result.append(
            DecompositionGroup(
                group_id=f"group-{index}", org_unit_ids=frozenset(member_sites), solve_input=group_input
            )
        )
    return result
