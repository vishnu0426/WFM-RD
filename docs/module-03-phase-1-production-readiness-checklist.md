# Module 03 Phase 1 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases (§0.5),
matching Module 01/02's phase-1 checklists' format and honesty bar.

## Delivered in this phase (application code)

- [x] Full DDL for every §2 entity plus `DataQualityCheck` (§2.2) and
      `ForecastRun.is_cold_start` (§2.3), with `upgrade`/`downgrade` migrations.
- [x] Row Level Security on every `forecasting.*` table, reusing Module 01's
      exact `app.current_tenant_id` GUC convention (ADR-0002/0017) rather than
      a parallel mechanism.
- [x] New `agno_forecasting_app` DB role, scoped to `USAGE` on `forecasting`
      only — no access to `core`/`org` (ADR-0017), proven by
      `tests/integration/test_rls_isolation.py`.
- [x] `forecast_data_points`/`forecast_accuracy_log` partitioned `RANGE`
      monthly (ADR-0018), bootstrap partitions only (current month ± 1).
- [x] Application-layer tenant guard (`TenantContext`/`tenant_scoped_session`)
      that fails closed with no bound context, Python analogue of
      `TenantScopedRepository`/`TenantContextService`.
- [x] `POST /v1/forecasting/jobs` / `GET /v1/forecasting/jobs/{jobId}` (§3.3),
      idempotency-key handling backed by a real unique constraint, standard
      error envelope (`{ error: { code, message, details } }`, reused from
      ADR-0015), `X-Request-Id`.
- [x] NATS JetStream publisher skeleton: connection lifecycle + idempotent
      stream bootstrap are real and tested; `publish_run_completed` itself is
      not called anywhere yet (nothing completes a run in this phase).
- [x] Concrete, numbered `DataQualityCheck` thresholds and cold-start defaults
      decided now (ADR-0019) so Phase 2 implements a spec, not invented
      numbers — satisfies §0's "no vague sufficiency/accuracy claims" rule
      even though the gate logic itself isn't built yet.
- [x] Unit tests (tenant context fail-closed/isolation, error envelope,
      middleware) + integration tests (RLS + guard against real Postgres,
      full job-submission HTTP contract against the real app + NATS).
- [x] `ruff`/`mypy` clean; `docker-compose.yml`/`scripts/init-roles.sql`
      updated additively (new `forecasting` schema/role, new `nats` service).

## Explicitly NOT done here (needs a different owner before go-live)

- [ ] **Terraform for real Postgres/NATS provisioning.** `docker-compose.yml`
      is local-dev only, same posture Module 01/02 already documented for
      their own Phase 1 — not extended here, just reused.
- [ ] **Vault (or equivalent) for credential issuance.**
      `agno_forecasting_app`'s password is a static placeholder in
      `.env.example`, same gap Module 01/02 flagged for their own roles.
- [ ] **`pg_partman` (or equivalent) for `forecast_data_points`/
      `forecast_accuracy_log` partition rotation.** This migration creates
      three fixed local-dev partitions per table; nothing creates next
      month's partition automatically. Same accepted gap as `audit_log`
      (ADR-0005), now with a second table pair inheriting it.
- [ ] **Load testing.** No load test exists yet — §0.5's per-model-type SLOs
      (job submission ack p99 < 200ms, etc.) are stated in the module prompt,
      not validated against this schema/service's actual behavior under
      concurrency.
- [ ] **A CI check diffing `app/db/models.py` against the migration SQL**,
      the Python analogue of Module 01's `migration:lint`. ADR-0016 accepts
      the same "two sources of truth" trade-off ADR-0001 did, but Module 01
      closed the gap with an enforced lint; this phase has not yet built the
      equivalent for this repo path. Flagged as a real gap, not assumed solved
      by naming the pattern.
- [ ] **Ray/GPU compute budget enforcement.** §0.5 asks for an explicit cost
      model per tenant tier; nothing in this phase trains a model, so there is
      no compute budget to enforce yet. Phase 3 (Ray orchestration) and
      Phase 8 (TFT/GPU entitlement gate) own this.
- [ ] **Penetration testing / SOC2 / ISO27001 program**, **SAST / dependency
      scanning / SBOM.** Same explicit non-goals Module 01/02 already stated
      for themselves (§9 of the source spec) — not re-litigated per module.
- [ ] **In-process or gateway-level rate limiting.** §3.3 names rate limiting
      as a cross-cutting requirement; nothing in this phase implements it —
      consistent with Module 01/02 also not having built a REST rate limiter
      anywhere yet. Ops/gateway-level work, not application code.
