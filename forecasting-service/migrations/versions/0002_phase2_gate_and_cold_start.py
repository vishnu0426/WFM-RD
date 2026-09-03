"""Module 03 Phase 2 - historical actuals landing table, plus the two local
settings tables the data-quality gate and cold-start matcher need
(`tenant_settings`, `queue_profiles`). See docs/adr/0020 for why these exist
and aren't reuses of `core.policies`/Module 02's `org.*` tables.

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-05
"""

from __future__ import annotations

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"
_VOLUME_BANDS = ("xs", "s", "m", "l", "xl")


def _rls(table: str) -> None:
    """Same shape as migration 0001's `_rls` helper - kept local to this
    file since Alembic migrations are independent, immutable-once-applied
    scripts (importing across migration files is deliberately avoided so a
    later edit to 0001 can never silently change what 0002 already applied)."""
    op.execute(f"ALTER TABLE forecasting.{table} ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON forecasting.{table} FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )


def upgrade() -> None:
    # -------------------------------------------------------------------
    # historical_actuals - PARTITION BY RANGE (interval_start), same
    # reasoning as forecast_data_points/forecast_accuracy_log (ADR-0018).
    # -------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE forecasting.historical_actuals (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          org_unit_id uuid NOT NULL,
          interval_start timestamptz NOT NULL,
          actual_volume numeric(14, 4),
          actual_aht_seconds numeric(10, 2),
          actual_shrinkage_pct numeric(6, 4),
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id, interval_start)
        ) PARTITION BY RANGE (interval_start);
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_historical_actuals_tenant_org_unit_interval "
        "ON forecasting.historical_actuals (tenant_id, org_unit_id, interval_start);"
    )
    _rls("historical_actuals")
    _create_monthly_partitions("historical_actuals")

    # -------------------------------------------------------------------
    # tenant_settings - ADR-0020 Gap 2. SELECT-only for agno_forecasting_app;
    # no application write path in this phase (see grants below).
    # -------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE forecasting.tenant_settings (
          tenant_id uuid PRIMARY KEY,
          tft_entitled boolean NOT NULL DEFAULT false,
          cold_start_cross_tenant_matching_enabled boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        """
    )
    op.execute(
        "CREATE TRIGGER trg_tenant_settings_updated_at BEFORE UPDATE ON forecasting.tenant_settings "
        "FOR EACH ROW EXECUTE FUNCTION forecasting.fn_set_updated_at();"
    )
    _rls("tenant_settings")

    # -------------------------------------------------------------------
    # queue_profiles - ADR-0020 Gap 3.
    # -------------------------------------------------------------------
    op.execute(
        f"""
        CREATE TABLE forecasting.queue_profiles (
          tenant_id uuid NOT NULL,
          org_unit_id uuid NOT NULL,
          industry varchar(64) NOT NULL,
          queue_type varchar(64) NOT NULL,
          expected_volume_band varchar(8) NOT NULL
            CHECK (expected_volume_band IN ({", ".join(f"'{b}'" for b in _VOLUME_BANDS)})),
          timezone_bucket varchar(64) NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (tenant_id, org_unit_id)
        );
        """
    )
    op.execute(
        "CREATE TRIGGER trg_queue_profiles_updated_at BEFORE UPDATE ON forecasting.queue_profiles "
        "FOR EACH ROW EXECUTE FUNCTION forecasting.fn_set_updated_at();"
    )
    _rls("queue_profiles")

    # -------------------------------------------------------------------
    # Grants
    # -------------------------------------------------------------------
    # UPDATE (not just SELECT, INSERT) is required: `ingest_actuals` upserts
    # via `ON CONFLICT DO UPDATE` so a resubmitted interval (e.g. a
    # corrected export) overwrites rather than duplicates - Postgres treats
    # a conflict-update clause as needing UPDATE privilege on the target
    # table even though the statement is nominally an INSERT. Missing this
    # originally; found by actually running the ingestion endpoint against
    # a real database, not by inspection - `historical_actuals_service.py`'s
    # own docstring already described upsert semantics the grant didn't
    # support.
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON forecasting.historical_actuals TO agno_forecasting_app;"
    )
    op.execute("GRANT SELECT ON forecasting.tenant_settings TO agno_forecasting_app;")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON forecasting.queue_profiles TO agno_forecasting_app;"
    )


def downgrade() -> None:
    op.execute("DROP TABLE forecasting.queue_profiles;")
    op.execute("DROP TABLE forecasting.tenant_settings;")
    op.execute("DROP TABLE forecasting.historical_actuals;")


def _create_monthly_partitions(table: str) -> None:
    """Same bootstrap-only scope as migration 0001 (ADR-0005/0018): current
    month +/- 1, no DEFAULT partition, production rotation is infra/process
    work. `historical_actuals` additionally gets a wider look-back window
    (13 months back) since, unlike `forecast_data_points`, this table needs
    to already hold real history for the gate/cold-start logic to have
    anything to evaluate on day one of a fresh local-dev environment - a
    brand-new environment with only +/-1 month of partitions would reject
    exactly the kind of backfilled test/seed data this table exists to
    hold."""
    op.execute(
        f"""
        DO $$
        DECLARE
          month_start date;
          month_end date;
          partition_name text;
        BEGIN
          FOR offset_months IN -13..1 LOOP
            month_start := date_trunc('month', now() + (offset_months || ' months')::interval);
            month_end := month_start + interval '1 month';
            partition_name := '{table}_' || to_char(month_start, 'YYYY_MM');
            EXECUTE format(
              'CREATE TABLE forecasting.%I PARTITION OF forecasting.{table} FOR VALUES FROM (%L) TO (%L);',
              partition_name, month_start, month_end
            );
          END LOOP;
        END $$;
        """
    )
