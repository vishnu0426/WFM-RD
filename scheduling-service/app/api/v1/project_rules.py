"""Reusable project-rule CRUD ("Project Rules" under Work Rules in the
reference console's own menu). See `ProjectRule`'s own doc comment
(`app/db/models.py`) for what this is and isn't used for.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import ProjectRuleRequest, ProjectRuleResponse, ProjectRuleUpdateRequest
from app.core.tenant_context import TenantContext
from app.db.models import ProjectRule
from app.services import project_rule_service

router = APIRouter(prefix="/v1/scheduling/project-rules", tags=["scheduling-project-rules"])


def _to_response(row: ProjectRule) -> ProjectRuleResponse:
    return ProjectRuleResponse(
        id=row.id,
        name=row.name,
        description=row.description,
        max_consecutive_working_days=row.max_consecutive_working_days,
        min_rest_hours_between_shifts=row.min_rest_hours_between_shifts,
        min_shift_length_minutes=row.min_shift_length_minutes,
        max_shift_length_minutes=row.max_shift_length_minutes,
        allows_overtime=row.allows_overtime,
    )


@router.post("", response_model=ProjectRuleResponse, status_code=status.HTTP_201_CREATED)
async def create_project_rule(
    body: ProjectRuleRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ProjectRuleResponse:
    row = await project_rule_service.create_project_rule(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        name=body.name,
        description=body.description,
        max_consecutive_working_days=body.max_consecutive_working_days,
        min_rest_hours_between_shifts=body.min_rest_hours_between_shifts,
        min_shift_length_minutes=body.min_shift_length_minutes,
        max_shift_length_minutes=body.max_shift_length_minutes,
        allows_overtime=body.allows_overtime,
    )
    return _to_response(row)


@router.get("", response_model=list[ProjectRuleResponse])
async def list_project_rules(
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[ProjectRuleResponse]:
    rows = await project_rule_service.list_project_rules(session, tenant_id=uuid.UUID(context.tenant_id))
    return [_to_response(row) for row in rows]


@router.patch("/{rule_id}", response_model=ProjectRuleResponse)
async def update_project_rule(
    rule_id: uuid.UUID,
    body: ProjectRuleUpdateRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ProjectRuleResponse:
    updates = body.model_dump(exclude_unset=True)
    row = await project_rule_service.update_project_rule(
        session, tenant_id=uuid.UUID(context.tenant_id), rule_id=rule_id, updates=updates
    )
    return _to_response(row)


@router.delete("/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project_rule(
    rule_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    await project_rule_service.delete_project_rule(
        session, tenant_id=uuid.UUID(context.tenant_id), rule_id=rule_id
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
