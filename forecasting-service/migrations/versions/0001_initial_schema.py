"""Module 03 Phase 1 - full initial `forecasting` schema

Full DDL for every §2 entity (`ForecastModel`, `ForecastRun`,
`ForecastDataPoint`, `SpecialEvent`, `ForecastAccuracyLog`,
`ScenarioSimulation`) plus the two flagged-gap tables built in from day one
(`DataQualityCheck`, §2.2) and the Phase-1-only `idempotency_keys` table
(§3.3's `Idempotency-Key` requirement). See docs/module-03-phase-1-design-doc.md
and docs/adr/0016-0019 for the reasoning behind every non-obvious choice below
(hand-written SQL over autogenerate, the new `forecasting` schema + role,
RANGE-by-time partitioning for the two high-volume tables, the concrete
data-quality thresholds).

Depends on Module 01's `core` schema already being applied (the `agno_migrator`
role and `agno_wfm` database already exist). Does NOT depend on Module 02's
`org` schema - per the design doc, this service never reads `org.*` tables
directly.

Revision ID: 0001
Revises:
Create Date: 2026-08-04
"""

from __future__ import annotations

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

# Postgres 15+ requires explicit CREATE on a non-owned database/schema even for
# a role with LOGIN - already granted to agno_migrator by Module 01/02's
# scripts/init-roles.sql, extended in this same PR for `forecasting` +
# `agno_forecasting_app` (see that file's diff).

_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"

_MODEL_TYPES = ("sarima", "prophet", "neuralprophet", "lightgbm", "tft")
_TARGET_METRICS = ("volume", "aht", "shrinkage")
_MODEL_STATUSES = ("active", "deprecated", "training", "failed")
_RUN_STATUSES = ("queued", "running", "completed", "failed")
_EVENT_TYPES = ("holiday", "marketing_campaign", "product_launch", "anomaly_flagged")
_DQ_FAILURE_REASONS = (
    "insufficient_history",
    "excessive_gaps",
    "insufficient_feature_coverage",
    "missing_tft_entitlement",
)


def _rls(table: str, *, tenant_col: str = "tenant_id") -> None:
    """Mirrors ADR-0002 exactly: ENABLE (not FORCE) RLS, one `FOR ALL` policy
    comparing `tenant_col` to the same session GUC Module 01 established -
    the plain `tenant_isolation` shape `InitialSchema.ts` uses for every
    ordinary tenant-scoped table (no `is_platform_admin` bypass; that escape
    hatch is specific to `core.tenants`' cross-tenant BPO semantics, ADR-0007,
    and does not apply here). `agno_migrator` owns every table here (never
    `agno_forecasting_app`), so plain ENABLE already binds the runtime role
    unconditionally, same reasoning as Module 01/02."""
    op.execute(f"ALTER TABLE forecasting.{table} ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON forecasting.{table} FOR ALL
        USING ({tenant_col} = {_TENANT_ID_EXPR})
        WITH CHECK ({tenant_col} = {_TENANT_ID_EXPR});
        """
    )


def upgrade() -> None:
    # -------------------------------------------------------------------
    # Schema
    # -------------------------------------------------------------------
    op.execute("CREATE SCHEMA IF NOT EXISTS forecasting;")

    # `agno_forecasting_app` has no USAGE on `core` (ADR-0017), so this schema
    # defines its own updated_at trigger function rather than reusing
    # `core.fn_set_updated_at()` the way Module 02's `org` schema does.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION forecasting.fn_set_updated_at()
        RETURNS trigger AS $$
        BEGIN
          NEW.updated_at := now();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )

    model_type_check = "CHECK (model_type IN (" + ", ".join(f"'{m}'" for m in _MODEL_TYPES) + "))"
    target_metric_check = (
        "CHECK (target_metric IN (" + ", ".join(f"'{m}'" for m in _TARGET_METRICS) + "))"
    )

    # -------------------------------------------------------------------
    # forecast_models
    # -------------------------------------------------------------------
    op.execute(
        f"""
        CREATE TABLE forecasting.forecast_models (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          org_unit_id uuid NOT NULL,
          model_type varchar(32) NOT NULL {model_type_check},
          target_metric varchar(16) NOT NULL {target_metric_check},
          trained_at timestamptz,
          backtest_mape numeric(10, 6),
          backtest_wfa numeric(10, 6),
          status varchar(16) NOT NULL DEFAULT 'training'
            CHECK (status IN ({", ".join(f"'{s}'" for s in _MODEL_STATUSES)})),
          artifact_uri text,
          training_data_window_start timestamptz,
          training_data_window_end timestamptz,
          minimum_data_volume_met boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_forecast_models_tenant_id UNIQUE (tenant_id, id)
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_forecast_models_tenant_org_unit ON forecasting.forecast_models "
        "(tenant_id, org_unit_id, target_metric, status);"
    )
    op.execute(
        "CREATE TRIGGER trg_forecast_models_updated_at BEFORE UPDATE ON forecasting.forecast_models "
        "FOR EACH ROW EXECUTE FUNCTION forecasting.fn_set_updated_at();"
    )
    _rls("forecast_models")

    # -------------------------------------------------------------------
    # forecast_runs
    # -------------------------------------------------------------------
    op.execute(
        f"""
        CREATE TABLE forecasting.forecast_runs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          org_unit_id uuid NOT NULL,
          forecast_model_id uuid,
          date_range_start date NOT NULL,
          date_range_end date NOT NULL,
          interval_minutes integer NOT NULL CHECK (interval_minutes > 0),
          status varchar(16) NOT NULL DEFAULT 'queued'
            CHECK (status IN ({", ".join(f"'{s}'" for s in _RUN_STATUSES)})),
          is_cold_start boolean NOT NULL DEFAULT false,
          created_by uuid,
          requested_at timestamptz NOT NULL DEFAULT now(),
          completed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_forecast_runs_tenant_id UNIQUE (tenant_id, id),
          CONSTRAINT ck_forecast_runs_date_range CHECK (date_range_end >= date_range_start),
          CONSTRAINT fk_forecast_runs_tenant_model FOREIGN KEY (tenant_id, forecast_model_id)
            REFERENCES forecasting.forecast_models (tenant_id, id)
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_forecast_runs_tenant_org_unit ON forecasting.forecast_runs "
        "(tenant_id, org_unit_id, date_range_start, date_range_end);"
    )
    op.execute(
        "CREATE INDEX ix_forecast_runs_tenant_status ON forecasting.forecast_runs "
        "(tenant_id, status);"
    )
    op.execute(
        "CREATE TRIGGER trg_forecast_runs_updated_at BEFORE UPDATE ON forecasting.forecast_runs "
        "FOR EACH ROW EXECUTE FUNCTION forecasting.fn_set_updated_at();"
    )
    _rls("forecast_runs")

    # -------------------------------------------------------------------
    # forecast_data_points - PARTITION BY RANGE (interval_start), ADR-0018
    # -------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE forecasting.forecast_data_points (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          forecast_run_id uuid NOT NULL,
          interval_start timestamptz NOT NULL,
          predicted_volume numeric(14, 4),
          predicted_aht_seconds numeric(10, 2),
          predicted_shrinkage_pct numeric(6, 4),
          confidence_lower numeric(14, 4),
          confidence_upper numeric(14, 4),
          required_headcount numeric(10, 2),
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id, interval_start),
          CONSTRAINT fk_forecast_data_points_tenant_run FOREIGN KEY (tenant_id, forecast_run_id)
            REFERENCES forecasting.forecast_runs (tenant_id, id)
        ) PARTITION BY RANGE (interval_start);
        """
    )
    op.execute(
        "CREATE INDEX ix_forecast_data_points_tenant_run ON forecasting.forecast_data_points "
        "(tenant_id, forecast_run_id, interval_start);"
    )
    _rls("forecast_data_points")
    _create_monthly_partitions("forecast_data_points")

    # -------------------------------------------------------------------
    # special_events
    # -------------------------------------------------------------------
    op.execute(
        f"""
        CREATE TABLE forecasting.special_events (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          org_unit_id uuid,
          event_type varchar(32) NOT NULL
            CHECK (event_type IN ({", ".join(f"'{e}'" for e in _EVENT_TYPES)})),
          date_range_start date NOT NULL,
          date_range_end date NOT NULL,
          expected_volume_multiplier numeric(6, 3),
          tagged_by uuid,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_special_events_tenant_id UNIQUE (tenant_id, id),
          CONSTRAINT ck_special_events_date_range CHECK (date_range_end >= date_range_start)
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_special_events_tenant_org_unit ON forecasting.special_events "
        "(tenant_id, org_unit_id, date_range_start, date_range_end);"
    )
    op.execute(
        "CREATE TRIGGER trg_special_events_updated_at BEFORE UPDATE ON forecasting.special_events "
        "FOR EACH ROW EXECUTE FUNCTION forecasting.fn_set_updated_at();"
    )
    _rls("special_events")

    # -------------------------------------------------------------------
    # forecast_accuracy_log - PARTITION BY RANGE (evaluated_at), ADR-0018
    # -------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE forecasting.forecast_accuracy_log (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          forecast_run_id uuid NOT NULL,
          org_unit_id uuid NOT NULL,
          actual_volume numeric(14, 4) NOT NULL,
          predicted_volume numeric(14, 4) NOT NULL,
          mape numeric(10, 6),
          bias numeric(10, 6),
          evaluated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id, evaluated_at),
          CONSTRAINT fk_forecast_accuracy_log_tenant_run FOREIGN KEY (tenant_id, forecast_run_id)
            REFERENCES forecasting.forecast_runs (tenant_id, id)
        ) PARTITION BY RANGE (evaluated_at);
        """
    )
    op.execute(
        "CREATE INDEX ix_forecast_accuracy_log_tenant_org_unit ON forecasting.forecast_accuracy_log "
        "(tenant_id, org_unit_id, evaluated_at);"
    )
    _rls("forecast_accuracy_log")
    _create_monthly_partitions("forecast_accuracy_log")

    # -------------------------------------------------------------------
    # scenario_simulations
    # -------------------------------------------------------------------
    op.execute(
        f"""
        CREATE TABLE forecasting.scenario_simulations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          base_forecast_run_id uuid NOT NULL,
          assumption_overrides jsonb NOT NULL,
          result_forecast_run_id uuid,
          status varchar(16) NOT NULL DEFAULT 'queued'
            CHECK (status IN ({", ".join(f"'{s}'" for s in _RUN_STATUSES)})),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_scenario_simulations_tenant_id UNIQUE (tenant_id, id),
          CONSTRAINT fk_scenario_simulations_tenant_base_run FOREIGN KEY (tenant_id, base_forecast_run_id)
            REFERENCES forecasting.forecast_runs (tenant_id, id),
          CONSTRAINT fk_scenario_simulations_tenant_result_run FOREIGN KEY (tenant_id, result_forecast_run_id)
            REFERENCES forecasting.forecast_runs (tenant_id, id)
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_scenario_simulations_tenant_status ON forecasting.scenario_simulations "
        "(tenant_id, status);"
    )
    op.execute(
        "CREATE TRIGGER trg_scenario_simulations_updated_at "
        "BEFORE UPDATE ON forecasting.scenario_simulations "
        "FOR EACH ROW EXECUTE FUNCTION forecasting.fn_set_updated_at();"
    )
    _rls("scenario_simulations")

    # -------------------------------------------------------------------
    # data_quality_checks - §2.2 gate, schema now / logic in Phase 2, ADR-0019
    # -------------------------------------------------------------------
    op.execute(
        f"""
        CREATE TABLE forecasting.data_quality_checks (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          org_unit_id uuid NOT NULL,
          model_type varchar(32) NOT NULL {model_type_check},
          target_metric varchar(16) NOT NULL {target_metric_check},
          passed boolean NOT NULL,
          failure_reason varchar(40)
            CHECK (failure_reason IN ({", ".join(f"'{r}'" for r in _DQ_FAILURE_REASONS)})),
          total_expected_intervals integer NOT NULL CHECK (total_expected_intervals >= 0),
          missing_intervals integer NOT NULL CHECK (missing_intervals >= 0),
          evaluated_at timestamptz NOT NULL DEFAULT now(),
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_data_quality_checks_tenant_id UNIQUE (tenant_id, id),
          CONSTRAINT ck_data_quality_checks_reason_matches_passed CHECK (
            (passed = true AND failure_reason IS NULL)
            OR (passed = false AND failure_reason IS NOT NULL)
          )
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_data_quality_checks_tenant_org_unit ON forecasting.data_quality_checks "
        "(tenant_id, org_unit_id, model_type, evaluated_at DESC);"
    )
    _rls("data_quality_checks")

    # -------------------------------------------------------------------
    # idempotency_keys - §3.3's Idempotency-Key requirement, Phase 1 addition
    # -------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE forecasting.idempotency_keys (
          tenant_id uuid NOT NULL,
          idempotency_key varchar(255) NOT NULL,
          forecast_run_id uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (tenant_id, idempotency_key),
          CONSTRAINT fk_idempotency_keys_tenant_run FOREIGN KEY (tenant_id, forecast_run_id)
            REFERENCES forecasting.forecast_runs (tenant_id, id)
        );
        """
    )
    _rls("idempotency_keys")

    # -------------------------------------------------------------------
    # Grants - table-level, explicit per table, matching scripts/init-roles.sql's
    # documented "exceptions are explicit and reviewable here" convention.
    # -------------------------------------------------------------------
    for table in (
        "forecast_models",
        "forecast_runs",
        "forecast_data_points",
        "special_events",
        "forecast_accuracy_log",
        "scenario_simulations",
        "data_quality_checks",
        "idempotency_keys",
    ):
        op.execute(
            f"GRANT SELECT, INSERT, UPDATE ON forecasting.{table} TO agno_forecasting_app;"
        )
    op.execute(
        "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA forecasting TO agno_forecasting_app;"
    )


def downgrade() -> None:
    op.execute("DROP SCHEMA forecasting CASCADE;")


def _create_monthly_partitions(table: str) -> None:
    """Bootstrap-only: current month +/- 1, same scope `audit_log` (ADR-0005)
    and this table (ADR-0018) both accept for Phase 1 - production partition
    rotation is infra/process work (pg_partman or equivalent), not this
    migration's job. No DEFAULT partition, deliberately (ADR-0005/0018): an
    insert into an unprovisioned month fails closed."""
    op.execute(
        f"""
        DO $$
        DECLARE
          month_start date;
          month_end date;
          partition_name text;
        BEGIN
          FOR offset_months IN -1..1 LOOP
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
