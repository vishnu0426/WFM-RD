"""§6's event-driven completion path (`agno.scheduling.job.completed.v1`),
publishing skeleton only in this phase - nothing in Phase 1 calls
`publish_job_completed` for real, since no CP-SAT solver exists yet to
complete a job (Phase 2+). What's real and tested here: the connection
lifecycle, the idempotent stream bootstrap, and the publish call's
shape/subject/dedup-header contract, so later phases wire a real trigger
into an already-proven publisher rather than building the NATS integration
under pressure alongside the first real solve.

Replaces the source spec's Kafka reference platform-wide, per the module
prompt's explicit override (same as Module 03).
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Literal

import nats
from nats.aio.client import Client as NatsClient
from nats.js import JetStreamContext

from app.config import Settings, get_settings

JOB_COMPLETED_SUBJECT = "agno.scheduling.job.completed.v1"
JobStatus = Literal["completed", "failed", "infeasible"]

# Module 05 Phase 2: added post-hoc so intraday-service can know *when* to
# pre-load `AgentLiveState.scheduled_activity` (§2.2 rule 2) rather than
# polling this service blindly - see docs/adr/0064. Both still live under
# `agno.scheduling.>`, so `bootstrap_stream`'s existing wildcard subject
# already covers them; no stream config change needed.
SCHEDULE_PUBLISHED_SUBJECT = "agno.scheduling.schedule.published.v1"
ASSIGNMENT_CHANGED_SUBJECT = "agno.scheduling.assignment.changed.v1"
# Module 07 Phase 5 (ADR-0089): "claim"/"swap" - a marketplace-approved
# reassignment applied by `app.nats.marketplace_consumer`, same event, same
# subject, just a new reason value - nothing about *how* an assignment
# changed determines *whether* Module 05 needs to know about it. "bid"
# (ADR-0159): a marketplace claim whose `source` was a closed
# `BidOpportunity`'s winner rather than a first-come claim - same event,
# same consumer, distinguishable in scheduling-service's own audit trail via
# `assignment_source` and here.
AssignmentChangeReason = Literal["manual_override", "claim", "swap", "bid"]


async def connect(settings: Settings | None = None) -> NatsClient:
    settings = settings or get_settings()
    return await nats.connect(settings.nats_url)


async def bootstrap_stream(js: JetStreamContext, settings: Settings | None = None) -> None:
    """Idempotent: `add_stream` updates an existing stream with the same name
    rather than erroring, so this is safe to call on every service startup -
    same posture as Module 03's own bootstrap (design doc assumption)."""
    settings = settings or get_settings()
    await js.add_stream(name=settings.nats_stream_name, subjects=["agno.scheduling.>"])


async def publish_job_completed(
    js: JetStreamContext,
    *,
    tenant_id: uuid.UUID,
    schedule_job_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    status: JobStatus,
) -> None:
    payload = {
        "tenantId": str(tenant_id),
        "scheduleJobId": str(schedule_job_id),
        "orgUnitId": str(org_unit_id),
        "status": status,
    }
    # Idempotent-consumer key (scheduleJobId + status) doubles as the
    # JetStream message-dedup id, so a redelivered publish (e.g. a retried
    # call after a network blip) is deduplicated at the broker, not just at
    # any downstream consumer (Module 10's explanation-generation trigger,
    # Phase 6).
    msg_id = f"{schedule_job_id}:{status}"
    await js.publish(
        JOB_COMPLETED_SUBJECT,
        json.dumps(payload).encode("utf-8"),
        headers={"Nats-Msg-Id": msg_id},
    )


async def publish_schedule_published(
    js: JetStreamContext,
    *,
    tenant_id: uuid.UUID,
    schedule_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    published_at: datetime,
    employee_ids: list[uuid.UUID],
) -> None:
    """Fired once per `publish_schedule` call - `employeeIds` is every
    employee with an assignment on this schedule, so a consumer doesn't
    have to separately query "who does this schedule affect" before it can
    decide whose `scheduled_activity` to start tracking."""
    payload = {
        "tenantId": str(tenant_id),
        "scheduleId": str(schedule_id),
        "orgUnitId": str(org_unit_id),
        "publishedAt": published_at.isoformat(),
        "employeeIds": [str(e) for e in employee_ids],
    }
    # Dedup on `scheduleId` alone (not `+status` like job-completed) -
    # `publish_schedule` rejects a second publish of the same schedule
    # (`ScheduleNotPublishableError`, `status != "draft"`), so this event can
    # only ever legitimately fire once per schedule.
    msg_id = f"{schedule_id}:published"
    await js.publish(
        SCHEDULE_PUBLISHED_SUBJECT,
        json.dumps(payload).encode("utf-8"),
        headers={"Nats-Msg-Id": msg_id},
    )


async def publish_assignment_changed(
    js: JetStreamContext,
    *,
    tenant_id: uuid.UUID,
    schedule_id: uuid.UUID,
    assignment_id: uuid.UUID,
    employee_id: uuid.UUID,
    shift_start: datetime,
    shift_end: datetime,
    changed_at: datetime,
    reason: AssignmentChangeReason,
) -> None:
    """Fired on `override_assignment` - unlike schedule-published, the same
    assignment can legitimately change more than once, so the dedup key
    includes `changed_at`, not just `assignment_id`."""
    payload = {
        "tenantId": str(tenant_id),
        "scheduleId": str(schedule_id),
        "assignmentId": str(assignment_id),
        "employeeId": str(employee_id),
        "shiftStart": shift_start.isoformat(),
        "shiftEnd": shift_end.isoformat(),
        "reason": reason,
    }
    msg_id = f"{assignment_id}:{changed_at.isoformat()}"
    await js.publish(
        ASSIGNMENT_CHANGED_SUBJECT,
        json.dumps(payload).encode("utf-8"),
        headers={"Nats-Msg-Id": msg_id},
    )
