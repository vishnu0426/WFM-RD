"""Module 07 Phase 5 (ADR-0089) - this service's first NATS *consumer*
(every prior NATS presence here, `app/events/nats_publisher.py`, is
publish-only). Applies `ShiftClaimApproved`/`SwapExecuted` events from
shift-marketplace-service's own `AGNO_MARKETPLACE_EVENTS` stream by
calling `schedule_service.apply_marketplace_claim`/`apply_marketplace_swap`
- the actual mechanism that makes Module 07's own guardrail-validated
claims/swaps real, locked `ShiftAssignment` rows Module 04's own solver
will never silently reassign on a future re-optimization (ADR-0058).

Durable pull consumer, not push - matches this platform's existing
JetStream consumer convention (intraday-service's own
`durable-jetstream-consumer.base.ts`): a strictly sequential fetch/ack
loop, `ack()` on success, `nak()` on a transient failure (triggers
JetStream redelivery), `term()` on a permanent/poison message (a
`DomainError` - e.g. the referenced `ShiftAssignment` genuinely doesn't
exist - redelivery would never fix it) with a best-effort publish to
`AGNO_MARKETPLACE_DLQ` so it isn't just silently dropped.

The consumer itself is created at runtime (`pull_subscribe`'s own
idempotent-if-already-exists behavior) - no separate provisioning step,
matching how `scripts/provision-nats-streams.ts` only ever provisions
*streams*, never consumers, for the Node-side services that already have
one.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid

import nats.errors
from nats.aio.msg import Msg
from nats.js import JetStreamContext
from nats.js.errors import FetchTimeoutError

from app.core.errors import DomainError
from app.core.tenant_context import TenantContext
from app.db.session import tenant_scoped_session
from app.services import schedule_service

logger = logging.getLogger(__name__)

STREAM_NAME = "AGNO_MARKETPLACE_EVENTS"
DURABLE_NAME = "scheduling-marketplace-consumer"
FILTER_SUBJECT = "agno.marketplace.>"
CLAIM_APPROVED_SUBJECT = "agno.marketplace.claim.approved.v1"
SWAP_EXECUTED_SUBJECT = "agno.marketplace.swap.executed.v1"
DLQ_SUBJECT = "agno.marketplace.dlq.v1"

_FETCH_BATCH_SIZE = 10
_FETCH_TIMEOUT_SECONDS = 2.0


async def run(js: JetStreamContext, stop_event: asyncio.Event) -> None:
    """The consumer's own long-lived loop - started as a background task
    from `app/main.py`'s lifespan, cancelled (via `stop_event`) on
    shutdown. A timeout on an idle stream is expected and silent, not an
    error - it just means "nothing new since the last fetch," the same as
    any other pull-consumer's normal idle state. `fetch()` raises the
    *core* `nats.errors.TimeoutError` for "no messages at all before the
    deadline" (confirmed against the installed nats-py version - not
    `nats.js.errors.FetchTimeoutError`, which is a distinct, narrower case
    this client library uses for a partial-batch timeout)."""
    sub = await js.pull_subscribe(FILTER_SUBJECT, durable=DURABLE_NAME, stream=STREAM_NAME)
    while not stop_event.is_set():
        try:
            msgs = await sub.fetch(batch=_FETCH_BATCH_SIZE, timeout=_FETCH_TIMEOUT_SECONDS)
        except (FetchTimeoutError, nats.errors.TimeoutError):
            continue
        except Exception as exc:  # noqa: BLE001 - the loop itself must never die on a transient broker blip
            logger.error("marketplace consumer fetch failed: %s", exc)
            await asyncio.sleep(1)
            continue
        for msg in msgs:
            await _handle_message(msg, js)


async def _handle_message(msg: Msg, js: JetStreamContext) -> None:
    try:
        payload = json.loads(msg.data.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        logger.error("marketplace consumer got an unparseable message on %s: %s", msg.subject, exc)
        await _terminate_to_dlq(msg, js, reason=f"unparseable payload: {exc}")
        return

    try:
        if msg.subject == CLAIM_APPROVED_SUBJECT:
            await _apply_claim_approved(payload, js)
        elif msg.subject == SWAP_EXECUTED_SUBJECT:
            await _apply_swap_executed(payload, js)
        else:
            await _terminate_to_dlq(msg, js, reason=f"unrecognized subject {msg.subject}")
            return
        await msg.ack()
    except DomainError as exc:
        # A real business-rule failure (e.g. the referenced ShiftAssignment
        # doesn't exist) - redelivery would fail identically every time, so
        # this is poison, not transient.
        logger.error("marketplace consumer permanently failed to apply %s: %s", msg.subject, exc.message)
        await _terminate_to_dlq(msg, js, reason=exc.message)
    except (KeyError, ValueError) as exc:
        # A malformed payload (missing/wrong-typed field, bad UUID) -
        # redelivery can never fix this either; same poison-message
        # treatment as a `DomainError`.
        logger.error("marketplace consumer got a malformed payload on %s: %s", msg.subject, exc)
        await _terminate_to_dlq(msg, js, reason=f"malformed payload: {exc}")
    except Exception as exc:  # noqa: BLE001 - anything else (DB/network blip) is assumed transient
        logger.error("marketplace consumer failed to apply %s: %s - will redeliver", msg.subject, exc)
        await msg.nak()


async def _terminate_to_dlq(msg: Msg, js: JetStreamContext, *, reason: str) -> None:
    await msg.term()
    try:
        dlq_payload = {
            "originalSubject": msg.subject,
            "originalPayload": msg.data.decode("utf-8", errors="replace"),
            "reason": reason,
        }
        await js.publish(DLQ_SUBJECT, json.dumps(dlq_payload).encode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - best-effort; the term() above already stopped redelivery
        logger.error("marketplace consumer failed to publish to DLQ for %s: %s", msg.subject, exc)


def _require_uuid(payload: dict[str, object], key: str) -> uuid.UUID:
    value = payload[key]
    if not isinstance(value, str):
        raise KeyError(f"{key!r} must be a string, got {type(value).__name__}")
    return uuid.UUID(value)


def _require_source(payload: dict[str, object]) -> str:
    value = payload.get("source", "open_shift_claim")
    if value not in ("open_shift_claim", "bid"):
        raise ValueError(f"source must be 'open_shift_claim' or 'bid', got {value!r}")
    assert isinstance(value, str)  # narrowed by the membership check above
    return value


async def _apply_claim_approved(payload: dict[str, object], js: JetStreamContext) -> None:
    tenant_id = _require_uuid(payload, "tenantId")
    context = TenantContext(tenant_id=str(tenant_id))
    # ADR-0159: Module 07's `source` field ('open_shift_claim'/'bid') tells us
    # which of `assignment_source`'s two still-unused-until-now values
    # applies. Older payloads (published before ADR-0159) carry no such
    # field - defaulting to 'open_shift_claim' preserves this consumer's
    # prior behavior for those rather than rejecting them as malformed.
    source = _require_source(payload)
    async with tenant_scoped_session(context) as session:
        await schedule_service.apply_marketplace_claim(
            session,
            tenant_id=tenant_id,
            shift_assignment_id=_require_uuid(payload, "shiftAssignmentId"),
            new_employee_id=_require_uuid(payload, "claimantEmployeeId"),
            source=source,
            js=js,
        )


async def _apply_swap_executed(payload: dict[str, object], js: JetStreamContext) -> None:
    tenant_id = _require_uuid(payload, "tenantId")
    context = TenantContext(tenant_id=str(tenant_id))
    async with tenant_scoped_session(context) as session:
        await schedule_service.apply_marketplace_swap(
            session,
            tenant_id=tenant_id,
            initiator_shift_id=_require_uuid(payload, "initiatorShiftId"),
            initiator_employee_id=_require_uuid(payload, "initiatorEmployeeId"),
            target_shift_id=_require_uuid(payload, "targetShiftId"),
            target_employee_id=_require_uuid(payload, "targetEmployeeId"),
            js=js,
        )
