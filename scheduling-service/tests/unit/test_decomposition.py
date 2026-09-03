"""§7.1/ADR-0061's decomposition strategy - pure, no DB/HTTP, same posture
as the rest of `app/solver/`.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

from app.solver.decomposition import DECOMPOSITION_EMPLOYEE_THRESHOLD, decompose
from app.solver.types import (
    Employee,
    EmployeeSkill,
    EmploymentPolicy,
    LockedAssignment,
    ShiftSlot,
    SolveInput,
)

_POLICY = EmploymentPolicy(
    max_consecutive_working_days=6, min_rest_hours_between_shifts=8.0, min_shift_length_minutes=60
)


def _employee(org_unit_id: uuid.UUID | None, *, skill_id: uuid.UUID | None = None) -> Employee:
    skills = (EmployeeSkill(skill_id=skill_id),) if skill_id else ()
    return Employee(id=uuid.uuid4(), contract_hours_per_week=40.0, org_unit_id=org_unit_id, skills=skills)


def _shift(
    org_unit_id: uuid.UUID | None, *, skill_id: uuid.UUID | None = None, headcount: int = 1
) -> ShiftSlot:
    start = datetime(2026, 3, 2, 9, tzinfo=UTC)
    return ShiftSlot(
        id=uuid.uuid4(),
        start=start,
        end=start + timedelta(hours=4),
        required_headcount=headcount,
        required_skill_id=skill_id,
        org_unit_id=org_unit_id,
    )


def _solve_input(employees: tuple[Employee, ...], shifts: tuple[ShiftSlot, ...]) -> SolveInput:
    day = date(2026, 3, 2)
    return SolveInput(
        date_range_start=day, date_range_end=day, employees=employees, shifts=shifts, policy=_POLICY
    )


def test_below_threshold_is_a_no_op() -> None:
    site = uuid.uuid4()
    solve_input = _solve_input((_employee(site),), (_shift(site),))
    groups = decompose(solve_input)
    assert len(groups) == 1
    assert groups[0].solve_input is solve_input


def test_a_single_site_above_threshold_does_not_decompose() -> None:
    site = uuid.uuid4()
    employees = tuple(_employee(site) for _ in range(DECOMPOSITION_EMPLOYEE_THRESHOLD + 1))
    solve_input = _solve_input(employees, (_shift(site),))
    groups = decompose(solve_input)
    assert len(groups) == 1


def test_shifts_missing_org_unit_id_disables_decomposition() -> None:
    site_a, site_b = uuid.uuid4(), uuid.uuid4()
    employees = tuple(_employee(site_a) for _ in range(DECOMPOSITION_EMPLOYEE_THRESHOLD + 1))
    shifts = (_shift(site_a), _shift(site_b), _shift(None))
    groups = decompose(_solve_input(employees, shifts))
    assert len(groups) == 1


def test_two_independent_sites_split_cleanly() -> None:
    site_a, site_b = uuid.uuid4(), uuid.uuid4()
    employees_a = tuple(_employee(site_a) for _ in range(DECOMPOSITION_EMPLOYEE_THRESHOLD))
    employees_b = tuple(_employee(site_b) for _ in range(5))
    shift_a, shift_b = _shift(site_a), _shift(site_b)
    solve_input = _solve_input(employees_a + employees_b, (shift_a, shift_b))

    groups = decompose(solve_input)

    assert len(groups) == 2
    by_site = {next(iter(g.org_unit_ids)): g for g in groups}
    assert len(by_site[site_a].solve_input.employees) == len(employees_a)
    assert len(by_site[site_b].solve_input.employees) == len(employees_b)
    assert by_site[site_a].solve_input.shifts == (shift_a,)
    assert by_site[site_b].solve_input.shifts == (shift_b,)


def test_a_rare_skill_neither_site_can_locally_cover_merges_the_sites() -> None:
    site_a, site_b = uuid.uuid4(), uuid.uuid4()
    rare_skill = uuid.uuid4()
    # The skill is required at *both* sites, and neither site's own local
    # pool has anyone qualified for it - a genuine shared-pool shortfall.
    employees_a = tuple(_employee(site_a) for _ in range(DECOMPOSITION_EMPLOYEE_THRESHOLD))
    employees_b = tuple(_employee(site_b) for _ in range(5))
    shift_a = _shift(site_a, skill_id=rare_skill)
    shift_b = _shift(site_b, skill_id=rare_skill)
    solve_input = _solve_input(employees_a + employees_b, (shift_a, shift_b))

    groups = decompose(solve_input)

    assert len(groups) == 1
    assert groups[0].org_unit_ids == frozenset({site_a, site_b})
    assert len(groups[0].solve_input.employees) == len(employees_a) + len(employees_b)


def test_a_skill_locally_covered_at_every_site_does_not_merge() -> None:
    site_a, site_b = uuid.uuid4(), uuid.uuid4()
    shared_skill = uuid.uuid4()
    employees_a = (_employee(site_a, skill_id=shared_skill),) + tuple(
        _employee(site_a) for _ in range(DECOMPOSITION_EMPLOYEE_THRESHOLD)
    )
    employees_b = (_employee(site_b, skill_id=shared_skill),) + tuple(_employee(site_b) for _ in range(4))
    shift_a = _shift(site_a, skill_id=shared_skill)
    shift_b = _shift(site_b, skill_id=shared_skill)
    solve_input = _solve_input(employees_a + employees_b, (shift_a, shift_b))

    groups = decompose(solve_input)

    assert len(groups) == 2


def test_fairness_history_counts_are_filtered_per_group() -> None:
    site_a, site_b = uuid.uuid4(), uuid.uuid4()
    emp_a = _employee(site_a)
    employees_a = (emp_a,) + tuple(_employee(site_a) for _ in range(DECOMPOSITION_EMPLOYEE_THRESHOLD))
    emp_b = _employee(site_b)
    employees_b = (emp_b,) + tuple(_employee(site_b) for _ in range(4))
    solve_input = SolveInput(
        date_range_start=date(2026, 3, 2),
        date_range_end=date(2026, 3, 2),
        employees=employees_a + employees_b,
        shifts=(_shift(site_a), _shift(site_b)),
        policy=_POLICY,
        fairness_history_counts={emp_a.id: 3, emp_b.id: 7},
    )

    groups = decompose(solve_input)

    by_site = {next(iter(g.org_unit_ids)): g for g in groups}
    assert by_site[site_a].solve_input.fairness_history_counts == {emp_a.id: 3}
    assert by_site[site_b].solve_input.fairness_history_counts == {emp_b.id: 7}


def test_locked_assignments_are_filtered_per_group() -> None:
    site_a, site_b = uuid.uuid4(), uuid.uuid4()
    employees_a = tuple(_employee(site_a) for _ in range(DECOMPOSITION_EMPLOYEE_THRESHOLD))
    employees_b = tuple(_employee(site_b) for _ in range(5))
    shift_a, shift_b = _shift(site_a), _shift(site_b)
    locked_a = LockedAssignment(employee_id=employees_a[0].id, shift_id=shift_a.id)
    locked_b = LockedAssignment(employee_id=employees_b[0].id, shift_id=shift_b.id)
    solve_input = SolveInput(
        date_range_start=date(2026, 3, 2),
        date_range_end=date(2026, 3, 2),
        employees=employees_a + employees_b,
        shifts=(shift_a, shift_b),
        policy=_POLICY,
        locked_assignments=(locked_a, locked_b),
    )

    groups = decompose(solve_input)

    by_site = {next(iter(g.org_unit_ids)): g for g in groups}
    assert by_site[site_a].solve_input.locked_assignments == (locked_a,)
    assert by_site[site_b].solve_input.locked_assignments == (locked_b,)
