""""Queue Analytics" under Workforce Analytics in the reference console's
own menu - a read-only aggregation of signals this platform already has for
a queue (org unit): forecast accuracy, service-level-target adherence,
latest Backlog Age reading, queue profile, and campaign membership. No new
domain model - `QueueProfile`'s own doc comment already establishes org
units as queues here, so this assembles existing telemetry rather than
inventing real-time occupancy/AHT/abandon-rate metrics this platform has no
live telephony signal for.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import (
    QueueAnalyticsAccuracySummary,
    QueueAnalyticsBacklog,
    QueueAnalyticsCampaign,
    QueueAnalyticsResponse,
    QueueProfileResponse,
    ServiceLevelTargetResponse,
)
from app.core.tenant_context import TenantContext
from app.db.models import BacklogAgeTemplate, Campaign, CampaignQueue, QueueProfile, ServiceLevelTarget
from app.services import accuracy_service, backlog_snapshot_service, headcount_service

router = APIRouter(prefix="/v1/forecasting/queue-analytics", tags=["forecasting-queue-analytics"])


def _backlog_status(age_minutes: int, template: BacklogAgeTemplate | None) -> str:
    if template is None:
        return "unknown"
    if age_minutes >= template.critical_threshold_minutes:
        return "critical"
    if age_minutes >= template.warning_threshold_minutes:
        return "warning"
    return "ok"


@router.get("/{org_unit_id}", response_model=QueueAnalyticsResponse)
async def get_queue_analytics(
    org_unit_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> QueueAnalyticsResponse:
    tenant_id = uuid.UUID(context.tenant_id)

    queue_profile_row = await session.scalar(
        select(QueueProfile).where(
            QueueProfile.tenant_id == tenant_id, QueueProfile.org_unit_id == org_unit_id
        )
    )
    queue_profile = (
        QueueProfileResponse(
            org_unit_id=org_unit_id,
            industry=queue_profile_row.industry,
            queue_type=queue_profile_row.queue_type,
            expected_volume_band=queue_profile_row.expected_volume_band,
            timezone_bucket=queue_profile_row.timezone_bucket,
        )
        if queue_profile_row
        else None
    )

    slt_row = await session.scalar(
        select(ServiceLevelTarget).where(
            ServiceLevelTarget.tenant_id == tenant_id, ServiceLevelTarget.org_unit_id == org_unit_id
        )
    )
    service_level_target = (
        ServiceLevelTargetResponse(
            org_unit_id=org_unit_id,
            target_service_level=slt_row.target_service_level,
            target_answer_time_seconds=slt_row.target_answer_time_seconds,
            max_occupancy=slt_row.max_occupancy,
            is_default=False,
        )
        if slt_row
        else ServiceLevelTargetResponse(
            org_unit_id=org_unit_id,
            target_service_level=Decimal(str(headcount_service.DEFAULT_TARGET_SERVICE_LEVEL)),
            target_answer_time_seconds=headcount_service.DEFAULT_TARGET_ANSWER_TIME_SECONDS,
            max_occupancy=Decimal(str(headcount_service.DEFAULT_MAX_OCCUPANCY)),
            is_default=True,
        )
    )

    accuracy_rows = await accuracy_service.get_accuracy_trend(
        session, tenant_id=tenant_id, org_unit_id=org_unit_id
    )
    mapes = [row.mape for row in accuracy_rows if row.mape is not None]
    latest_accuracy = accuracy_rows[-1] if accuracy_rows else None
    accuracy = QueueAnalyticsAccuracySummary(
        point_count=len(accuracy_rows),
        avg_mape=(sum(mapes, Decimal(0)) / len(mapes)) if mapes else None,
        latest_evaluated_at=latest_accuracy.evaluated_at if latest_accuracy else None,
        latest_actual_volume=latest_accuracy.actual_volume if latest_accuracy else None,
        latest_predicted_volume=latest_accuracy.predicted_volume if latest_accuracy else None,
    )

    backlog_rows = await backlog_snapshot_service.list_backlog_snapshots(
        session, tenant_id=tenant_id, org_unit_id=org_unit_id, limit=1
    )
    latest_backlog = None
    if backlog_rows:
        latest = backlog_rows[0]
        template = (
            await session.scalar(
                select(BacklogAgeTemplate).where(
                    BacklogAgeTemplate.tenant_id == tenant_id, BacklogAgeTemplate.id == latest.template_id
                )
            )
            if latest.template_id
            else None
        )
        latest_backlog = QueueAnalyticsBacklog(
            item_count=latest.item_count,
            oldest_item_age_minutes=latest.oldest_item_age_minutes,
            recorded_at=latest.recorded_at,
            status=_backlog_status(latest.oldest_item_age_minutes, template),
        )

    campaign_rows = await session.execute(
        select(Campaign)
        .join(CampaignQueue, CampaignQueue.campaign_id == Campaign.id)
        .where(CampaignQueue.tenant_id == tenant_id, CampaignQueue.org_unit_id == org_unit_id)
    )
    campaigns = [
        QueueAnalyticsCampaign(id=row.id, name=row.name, status=row.status)
        for row in campaign_rows.scalars().all()
    ]

    return QueueAnalyticsResponse(
        org_unit_id=org_unit_id,
        queue_profile=queue_profile,
        service_level_target=service_level_target,
        accuracy=accuracy,
        latest_backlog=latest_backlog,
        campaigns=campaigns,
    )
