"""§2's `ScheduleExplanation` persistence - Phase 6's handoff to Module 10
(§1's mandated stack: "Module 04 requests it, doesn't own the LLM call").
This module's own responsibility ends at publishing the completion event
(`job_service`'s `nats_publisher.publish_job_completed`, the trigger Module
10 subscribes to per ADR-0059) and storing whatever Module 10 calls back
with - it never generates an explanation itself.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ScheduleExplanation
from app.services.job_service import get_job


async def submit_explanation(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    job_id: uuid.UUID,
    summary_text: str,
    top_constraints: dict[str, Any],
    trade_offs: dict[str, Any],
    generated_by_model_id: uuid.UUID | None,
) -> ScheduleExplanation:
    await get_job(session, tenant_id=tenant_id, job_id=job_id)  # 404s if not this tenant's job

    now = datetime.now(UTC)
    explanation = await session.scalar(
        select(ScheduleExplanation).where(
            ScheduleExplanation.tenant_id == tenant_id, ScheduleExplanation.schedule_job_id == job_id
        )
    )
    if explanation is None:
        explanation = ScheduleExplanation(
            id=uuid.uuid4(), tenant_id=tenant_id, schedule_job_id=job_id, created_at=now
        )
        session.add(explanation)

    explanation.summary_text = summary_text
    explanation.top_constraints_json = top_constraints
    explanation.trade_offs_json = trade_offs
    explanation.generated_by_model_id = generated_by_model_id
    explanation.updated_at = now
    await session.flush()
    return explanation


async def get_explanation(
    session: AsyncSession, *, tenant_id: uuid.UUID, job_id: uuid.UUID
) -> ScheduleExplanation | None:
    explanation: ScheduleExplanation | None = await session.scalar(
        select(ScheduleExplanation).where(
            ScheduleExplanation.tenant_id == tenant_id, ScheduleExplanation.schedule_job_id == job_id
        )
    )
    return explanation
