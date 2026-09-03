"""Unified request/approval workflow behind "Shift Events", "VTO Events",
and "OT Extensions" in the reference console's own menu - see
`ShiftEventRequest`'s own doc comment (`app/db/models.py`) for the
one-table/`event_type`-discriminator design. Same tenant-scoped-table shape
as 0006/0007/0008, plus CHECK constraints on `event_type`/`status` (a real
workflow state machine, not free-standing reference data) and a rejection-
requires-a-reason constraint mirroring Module 06's own `LeaveRequest` rule.

Revision ID: 0009
Revises: 0008
Create Date: 2026-08-24
"""

from __future__ import annotations

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE scheduling.shift_event_requests (
          id                uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id         uuid NOT NULL,
          employee_id       uuid NOT NULL,
          event_type        varchar(20) NOT NULL,
          shift_date        date NOT NULL,
          requested_hours   numeric(5,2),
          reason            varchar(500) NOT NULL,
          status            varchar(16) NOT NULL DEFAULT 'pending',
          decision_reason   varchar(500),
          requested_by      uuid,
          decided_by        uuid,
          decided_at        timestamptz,
          created_at        timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id),
          CONSTRAINT shift_event_requests_event_type_check
            CHECK (event_type IN ('shift_change', 'vto', 'overtime_extension')),
          CONSTRAINT shift_event_requests_status_check
            CHECK (status IN ('pending', 'approved', 'rejected')),
          CONSTRAINT shift_event_requests_rejection_reason_check
            CHECK (status <> 'rejected' OR decision_reason IS NOT NULL)
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_shift_event_requests_tenant_type_status "
        "ON scheduling.shift_event_requests (tenant_id, event_type, status);"
    )
    op.execute("ALTER TABLE scheduling.shift_event_requests ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON scheduling.shift_event_requests FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )
    # No DELETE grant — a decided request is a workflow/audit record, not
    # editable reference data (matches Module 06's own LeaveRequest posture).
    op.execute("GRANT SELECT, INSERT, UPDATE ON scheduling.shift_event_requests TO agno_scheduling_app;")


def downgrade() -> None:
    op.execute("DROP TABLE scheduling.shift_event_requests;")
