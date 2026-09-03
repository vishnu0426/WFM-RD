"""Phase 6/ADR-0059's `EmployeeService` pull - replaces ADR-0055's
request-supplied `roster` when a job submission omits it. Fetches the org
unit's full schedulable roster (`GetSchedulableEmployees`, no skill/hours
filter - eligibility gating is the solver's own job, §3.1) plus each
employee's skill matrix (`GetEmployeeSkillMatrix`), and assembles them into
this module's own `Employee` dataclasses.

`Employee.overtime_approved` has no source anywhere in this platform yet -
`SchedulableEmployee` (employee.proto) carries no such field, and Module
02's own `Employee` entity has no such column either. Every gRPC-pulled
employee gets `overtime_approved=False` (the safe default: never silently
allow unapproved overtime) - the same class of permanent, honestly-flagged
gap as leave/unavailability (ADR-0059), not something this phase can fix by
itself.
"""

from __future__ import annotations

import uuid
from datetime import date

import grpc

from app.grpc_clients.generated import employee_pb2, employee_pb2_grpc
from app.grpc_clients.retry import call_with_retry
from app.solver.types import Employee, EmployeeSkill

_SERVICE = "EmployeeService"


async def get_schedulable_roster(
    channel: grpc.aio.Channel, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID
) -> tuple[Employee, ...]:
    stub = employee_pb2_grpc.EmployeeServiceStub(channel)

    async def _stream_employees() -> list[employee_pb2.SchedulableEmployee]:
        request = employee_pb2.GetSchedulableEmployeesRequest(
            tenant_id=str(tenant_id), org_unit_id=str(org_unit_id)
        )
        return [item async for item in stub.GetSchedulableEmployees(request)]

    employees = await call_with_retry(_SERVICE, "GetSchedulableEmployees", _stream_employees)
    if not employees:
        return ()

    employee_ids = [e.employee_id for e in employees]

    async def _fetch_skill_matrix() -> employee_pb2.EmployeeSkillMatrixResponse:
        request = employee_pb2.GetEmployeeSkillMatrixRequest(
            tenant_id=str(tenant_id), employee_ids=employee_ids
        )
        return await stub.GetEmployeeSkillMatrix(request)

    skill_matrix = await call_with_retry(_SERVICE, "GetEmployeeSkillMatrix", _fetch_skill_matrix)
    skills_by_employee: dict[str, list[EmployeeSkill]] = {}
    for entry in skill_matrix.entries:
        skills_by_employee.setdefault(entry.employee_id, []).append(
            EmployeeSkill(
                skill_id=uuid.UUID(entry.skill_id),
                expires_at=date.fromisoformat(entry.expiry_date) if entry.expiry_date else None,
                decay_score=entry.decay_score,
            )
        )

    return tuple(
        Employee(
            id=uuid.UUID(e.employee_id),
            contract_hours_per_week=e.contract_hours_per_week,
            overtime_approved=False,
            skills=tuple(skills_by_employee.get(e.employee_id, [])),
            # Phase 7 (ADR-0061): `SchedulableEmployee.org_unit_id` (the
            # response's own field, not just the request filter) - needed by
            # `app/solver/decomposition.py`'s per-site partitioning.
            org_unit_id=uuid.UUID(e.org_unit_id) if e.org_unit_id else None,
        )
        for e in employees
    )
