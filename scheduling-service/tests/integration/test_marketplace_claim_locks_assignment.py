"""Module 07 Phase 5 (ADR-0089) end-to-end proof: publishing a real
`ShiftClaimApproved` event to `AGNO_MARKETPLACE_EVENTS` - the exact wire
contract shift-marketplace-service's own `MarketplaceEventPublisherService`
sends - causes this service's own NATS consumer (a background task
started by `app/main.py`'s lifespan, the same real process
`TestClient(app)` boots) to reassign the real `ShiftAssignment` row with
`assignmentSource: claim`/`locked: true`, and that a subsequent
re-optimization keeps it locked exactly as `test_override_and_reoptimize_
api.py` already proves for a manual override.

This is deliberately *not* a mock of the consumer - the whole point (the
module prompt's own words, restated in ADR-0089) is "this module's whole
purpose depends on that downstream rule actually being enforced; verify it
in integration testing, don't just assume it." A real NATS publish, a
real background consumer task, a real Postgres row, and a real CP-SAT
re-optimization are all exercised here.
"""

from __future__ import annotations

import json
import time
import uuid
from datetime import UTC, date, datetime, timedelta

import nats
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from tests.jwt_test_helpers import auth_headers

from .conftest import poll_until_terminal

pytestmark = pytest.mark.asyncio

_DEFAULT_POLICY = {
    "maxConsecutiveWorkingDays": 5,
    "minRestHoursBetweenShifts": 10.0,
    "minShiftLengthMinutes": 240,
    "maxShiftLengthMinutes": 600,
}

_CLAIM_APPROVED_SUBJECT = "agno.marketplace.claim.approved.v1"


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return {**auth_headers(tenant_id), "Idempotency-Key": str(uuid.uuid4())}


def _shift(day: date, start_hour: int, duration_hours: float, *, headcount: int = 1) -> dict[str, object]:
    start = datetime(day.year, day.month, day.day, start_hour, tzinfo=UTC)
    end = start + timedelta(hours=duration_hours)
    return {
        "id": str(uuid.uuid4()),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "requiredHeadcount": headcount,
    }


def _employee(*, contract_hours: float = 40.0) -> dict[str, object]:
    return {"id": str(uuid.uuid4()), "contractHoursPerWeek": contract_hours, "overtimeApproved": False}


def _submit_job(client: TestClient, tenant_id: uuid.UUID, body: dict[str, object]) -> dict[str, object]:
    response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_id))
    assert response.status_code == 201, response.text
    job = poll_until_terminal(client, tenant_id, response.json()["jobId"])
    assert job["status"] == "completed", job
    return job


def _get_schedule(client: TestClient, tenant_id: uuid.UUID, job_id: str) -> dict[str, object]:
    response = client.get(f"/v1/scheduling/jobs/{job_id}/schedule", headers=auth_headers(tenant_id))
    assert response.status_code == 200, response.text
    return dict(response.json())


async def _publish_claim_approved(
    *,
    tenant_id: uuid.UUID,
    marketplace_claim_id: uuid.UUID,
    marketplace_post_id: uuid.UUID,
    shift_assignment_id: str,
    claimant_employee_id: str,
    source: str | None = None,
) -> None:
    settings = get_settings()
    nc = await nats.connect(settings.nats_url)
    try:
        js = nc.jetstream()
        payload: dict[str, object] = {
            "tenantId": str(tenant_id),
            "marketplaceClaimId": str(marketplace_claim_id),
            "marketplacePostId": str(marketplace_post_id),
            "shiftAssignmentId": shift_assignment_id,
            "claimantEmployeeId": claimant_employee_id,
            "approvedBy": None,
            "approvedAt": datetime.now(UTC).isoformat(),
        }
        # `source` is omitted (not just left implicit) when the caller wants
        # to prove the pre-ADR-0159 payload shape still works - see
        # `test_shift_claim_approved_reassigns_and_locks_the_assignment`.
        if source is not None:
            payload["source"] = source
        await js.publish(
            _CLAIM_APPROVED_SUBJECT,
            json.dumps(payload).encode("utf-8"),
            headers={"Nats-Msg-Id": str(marketplace_claim_id)},
        )
    finally:
        await nc.close()


def _poll_schedule_assignment(
    client: TestClient,
    tenant_id: uuid.UUID,
    job_id: str,
    shift_start_iso: str,
    expected_employee_id: str,
    *,
    timeout: float = 10.0,
) -> dict[str, object]:
    # Same normalization `_index_by_shift_start`/`_get_schedule` callers use
    # in `test_override_and_reoptimize_api.py`: `shiftStart` round-trips
    # through Postgres `Z`-suffixed, but the caller's own `shift_start_iso`
    # may not be - normalize both sides through `fromisoformat` before
    # comparing, or every lookup silently misses.
    target_key = datetime.fromisoformat(shift_start_iso).isoformat()
    deadline = time.monotonic() + timeout
    last: dict[str, object] | None = None
    while time.monotonic() < deadline:
        schedule = _get_schedule(client, tenant_id, job_id)
        by_start = {
            datetime.fromisoformat(str(a["shiftStart"])).isoformat(): a for a in schedule["assignments"]
        }
        assignment = by_start.get(target_key)
        if assignment is not None:
            last = assignment
            if assignment["employeeId"] == expected_employee_id:
                return assignment
        time.sleep(0.2)
    raise AssertionError(f"assignment never reflected the marketplace claim within {timeout}s: {last}")


async def test_shift_claim_approved_reassigns_and_locks_the_assignment(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=10)
    e1, e2 = _employee(), _employee()
    shift = _shift(day, 9, 4)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [e1, e2],
        "shiftSlots": [shift],
        "leaveRecords": [],
    }
    with TestClient(app) as client:
        job = _submit_job(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        assignment = schedule["assignments"][0]
        assert assignment["assignmentSource"] == "auto_generated"
        assert assignment["locked"] is False

        # The claimant is whichever employee did NOT already win the
        # auto-generated assignment - a genuine reassignment, not a no-op.
        claimant_id = e2["id"] if assignment["employeeId"] == e1["id"] else e1["id"]

        await _publish_claim_approved(
            tenant_id=tenant_a_id,
            marketplace_claim_id=uuid.uuid4(),
            marketplace_post_id=uuid.uuid4(),
            shift_assignment_id=str(assignment["id"]),
            claimant_employee_id=str(claimant_id),
        )

        reassigned = _poll_schedule_assignment(
            client, tenant_a_id, str(job["id"]), str(assignment["shiftStart"]), str(claimant_id)
        )

    assert reassigned["employeeId"] == claimant_id
    assert reassigned["assignmentSource"] == "claim"
    assert reassigned["locked"] is True


async def test_the_marketplace_claim_survives_a_future_reoptimization(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=10)
    e1, e2, e3 = _employee(), _employee(), _employee()
    shift_a = _shift(day, 9, 4)
    shift_b = _shift(day, 15, 4)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [e1, e2],
        "shiftSlots": [shift_a, shift_b],
        "leaveRecords": [],
    }
    with TestClient(app) as client:
        job = _submit_job(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        schedule_id = schedule["id"]
        by_start = {
            datetime.fromisoformat(str(a["shiftStart"])).isoformat(): a for a in schedule["assignments"]
        }
        assignment_a = by_start[shift_a["start"]]

        # e3 claims shift_a via the marketplace - a real out-of-band
        # decision, exactly like the manual-override test's own e3, just
        # arriving via NATS instead of the REST override endpoint.
        await _publish_claim_approved(
            tenant_id=tenant_a_id,
            marketplace_claim_id=uuid.uuid4(),
            marketplace_post_id=uuid.uuid4(),
            shift_assignment_id=str(assignment_a["id"]),
            claimant_employee_id=str(e3["id"]),
        )
        _poll_schedule_assignment(
            client, tenant_a_id, str(job["id"]), str(assignment_a["shiftStart"]), str(e3["id"])
        )

        # Re-optimize: e3 must be in the resupplied roster (ADR-0058's
        # forced variable needs an Employee to build a decision variable
        # for), and both shifts must be resupplied so the locked shift_a
        # can be matched by (start, end, requiredSkillId) - same
        # requirement `test_override_and_reoptimize_api.py` documents for a
        # manual override; a marketplace claim is locked the exact same
        # way (ADR-0089's whole point).
        reoptimize_body = {
            "policy": _DEFAULT_POLICY,
            "roster": [e1, e2, e3],
            "shiftSlots": [shift_a, shift_b],
            "leaveRecords": [],
        }
        response = client.post(
            f"/v1/scheduling/schedules/{schedule_id}/reoptimize",
            json=reoptimize_body,
            headers=_headers(tenant_a_id),
        )
        assert response.status_code == 201, response.text
        new_job = poll_until_terminal(client, tenant_a_id, response.json()["jobId"])
        assert new_job["status"] == "completed", new_job

        new_schedule = _get_schedule(client, tenant_a_id, str(new_job["id"]))

    new_by_start = {
        datetime.fromisoformat(str(a["shiftStart"])).isoformat(): a for a in new_schedule["assignments"]
    }
    # shift_a stayed locked onto e3 (the marketplace claimant), with its
    # `claim` assignment_source intact - the solver never silently
    # reassigned it, even though e3 wasn't in the original roster at all.
    assert new_by_start[shift_a["start"]]["employeeId"] == e3["id"]
    assert new_by_start[shift_a["start"]]["assignmentSource"] == "claim"
    assert new_by_start[shift_a["start"]]["locked"] is True
    # shift_b was freely solved among the rest of the roster.
    assert new_by_start[shift_b["start"]]["employeeId"] in {e1["id"], e2["id"]}
    assert new_by_start[shift_b["start"]]["assignmentSource"] == "auto_generated"


async def test_shift_claim_approved_with_bid_source_locks_the_assignment_as_bid(tenant_a_id: uuid.UUID) -> None:
    """ADR-0159: shift-marketplace-service's `BidService.closeBidOpportunity`
    now sends `source: "bid"` on a converted bid winner - `assignment_source`
    must land as `bid`, not the default `claim`, so a bid-won assignment is
    distinguishable in scheduling-service's own audit trail exactly the way
    `assignment_source`'s CHECK constraint has always intended (`bid` has
    been a valid value since 0001, unused until this)."""
    day = date.today() + timedelta(days=10)
    e1, e2 = _employee(), _employee()
    shift = _shift(day, 9, 4)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [e1, e2],
        "shiftSlots": [shift],
        "leaveRecords": [],
    }
    with TestClient(app) as client:
        job = _submit_job(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        assignment = schedule["assignments"][0]
        claimant_id = e2["id"] if assignment["employeeId"] == e1["id"] else e1["id"]

        await _publish_claim_approved(
            tenant_id=tenant_a_id,
            marketplace_claim_id=uuid.uuid4(),
            marketplace_post_id=uuid.uuid4(),
            shift_assignment_id=str(assignment["id"]),
            claimant_employee_id=str(claimant_id),
            source="bid",
        )

        reassigned = _poll_schedule_assignment(
            client, tenant_a_id, str(job["id"]), str(assignment["shiftStart"]), str(claimant_id)
        )

    assert reassigned["employeeId"] == claimant_id
    assert reassigned["assignmentSource"] == "bid"
    assert reassigned["locked"] is True
