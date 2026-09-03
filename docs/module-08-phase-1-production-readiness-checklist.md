# Module 08 Phase 1 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely a later phase's work, matching every prior module's phase-1
checklist format and honesty bar. This module carries more real Phase-1
architectural decisions than most (§0.6's cross-module conflict, §1's stale
Kafka/ClickHouse correction, §5a/§5b's two new entities) — the ADR count
below is longer than a typical Phase 1 as a direct result, not scope creep.

## Delivered in this phase (application code)

- [x] Full §2.1 schema plus §5a/§5b's two closing-the-gap additions —
      `adherence_score`, `occupancy_record`, `shrinkage_record`,
      `compliance_rule`, `compliance_report`, `rule_change_impact_preview`,
      `retention_policy` — in one migration
      (`1700003000000-InitialComplianceSchema.ts`), new `compliance`
      schema/`agno_compliance_app` role (ADR-0093), RLS on all seven tables
      (ADR-0002 convention on five of them; ADR-0095's split policy on
      `compliance_rule`/`retention_policy`), tenant-id-first indexes,
      `varchar`+`CHECK` enums (ADR-0003).
- [x] §2.2 rule 2's citation requirement is schema-structural
      (`compliance_rule_citation_required_check`), not an application-layer
      convention — a `ComplianceRule` without a non-empty citation cannot be
      inserted, full stop.
- [x] §2.2 rule 4's idempotent/resumable rollup-job requirement has its
      exact `ON CONFLICT` target already in place
      (`adherence_score_upsert_key`/`occupancy_record_upsert_key`/
      `shrinkage_record_upsert_key`) — decided now so Phase 3's rollup job
      isn't guessing at schema shape under its own deadline, the same
      reasoning attendance-leave's ADR-0074 documents for `LeaveBalance`'s
      PK.
- [x] §2.2 rule 3's platform-default/tenant-override model is real at the
      RLS-policy level, not just documented intent: a tenant connection can
      read a platform-default `ComplianceRule`/`RetentionPolicy` row and can
      never write one, verified by both the migration's own unit test and a
      real-Postgres check (see below). Version-uniqueness is enforced by two
      partial unique indexes specifically because a plain composite
      constraint would not catch a platform-default collision (ADR-0095).
- [x] §5b's `retentionExpiresAt`/`legalHold` are real schema, not a promise —
      `NOT NULL` and `DEFAULT false` respectively, plus the partial index the
      Phase 7 lifecycle job depends on (`idx_compliance_report_retention_expires_unheld`).
      `agno_compliance_app` is granted `DELETE` on `compliance_report` alone,
      the one deliberate exception to this platform's usual no-DELETE
      convention (ADR-0096).
- [x] TypeORM entity classes for all seven tables
      (`src/adherence/entities/`, `src/compliance/entities/`), each backed by
      a TS `enum` for its `varchar`+`CHECK` columns.
- [x] `/healthz` (liveness, no dependency checks) / `/readyz` (Postgres
      `SELECT 1`-blocking, `degraded` on failure) / `/metrics` (Prometheus
      text exposition: `http_request_duration_seconds`/`_total`, plus four
      module-specific metrics declared now against §0.5/§6's SLOs and
      governance signals even though nothing records into them until Phase
      3/4/5: `compliance_rollup_job_lag_seconds`,
      `compliance_rollup_job_runs_total`,
      `compliance_validate_policy_against_floor_calls_total`,
      `compliance_impact_preview_flagged_but_activated_total`).
- [x] Standard REST error envelope (`{ error: { code, message } }`) via
      `DomainErrorFilter`, tenant-context header-trust placeholder
      (ADR-0014's convention) via `TenantContextMiddleware`/`Service`.
- [x] OpenTelemetry auto-instrumentation wired at boot, same import-order
      constraint and no-op-safe-without-a-collector posture as every other
      service's `tracing.ts` in this platform.
- [x] `scripts/init-roles.sql` additively gains `agno_compliance_app` and
      the `compliance` schema block; `observability/prometheus.yml`
      additively gains the `agno-wfm-adherence-compliance-service` scrape
      job (port 8500) — every existing role/schema/job entry untouched.
- [x] Four ADRs written now, per this platform's Phase 1 convention: 0093
      (schema/role), 0094 (rollup source: Postgres direct read, not NATS —
      closes §1's explicitly-flagged stale-Kafka/ClickHouse correction),
      0095 (nullable-tenant-id platform-default RLS model), 0096
      (retention: row-level legal-hold-guarded delete, not partition-drop).
- [x] Unit test coverage for entity/migration shape (all seven tables' RLS
      policies including the nullable-tenant-id split, the citation `CHECK`,
      the upsert-key unique constraints, the retention/legal-hold columns and
      partial index, the DELETE-on-`compliance_report`-only grant, enum
      value sets) — no live Postgres required to run `npm test`.
- [x] No `docker-compose.yml` change needed — this service boots and serves
      `/healthz`/`/readyz`/`/metrics` against the already-running `postgres`
      container docker-compose already provisions, once `npm run
      migration:run` has been run against it.
- [x] Verified against a real local Postgres, not just unit tests:
      `scripts/init-roles.sql`'s additive block applies cleanly,
      `migration:run` executes end to end, the built app boots and serves
      `/healthz`/`/readyz`/`/metrics` using the least-privilege
      `agno_compliance_app` role, RLS actually blocks a cross-tenant read,
      the `compliance_rule_citation_required_check` constraint actually
      rejects an empty-citation insert, and ADR-0095's split policy actually
      lets a tenant session read a platform-default row while rejecting
      that same session's attempt to write one.

## Explicitly NOT done here (needs a later phase)

- [ ] **Any request path that actually writes these tables.** This phase is
      schema/migrations only — there is no controller, resolver, or service
      method anywhere in `adherence-compliance-service/` yet. Do not treat a
      clean `migration:run` as evidence any mutation logic works; none
      exists to test.
- [ ] **The rollup job runner** (Postgres-direct-read against Module 05's
      rollup tables per ADR-0094, upserting into `adherence_score`/
      `occupancy_record`/`shrinkage_record`) and **the §0.5 reproducibility
      test** ("same report requested twice returns identical numbers") that
      depends on it existing. The schema supports idempotent upsert; nothing
      exercises it yet. Phase 3.
- [ ] **`createComplianceRule`/`activateComplianceRule`, citation
      enforcement at the application layer, and the platform-admin-vs-
      tenant-override write-authorization decision ADR-0095 explicitly
      flags as unresolved.** No code writes a `ComplianceRule` row of any
      kind yet — platform-default or tenant-scoped. Phase 2.
- [ ] **`ComplianceRuleService.GetActiveRule`/`ValidatePolicyAgainstFloor`
      gRPC surface, and the real Module 02/04 reconciliation work §0.6
      requires** (Module 02's `EmploymentPolicy` write path calling
      `ValidatePolicyAgainstFloor`, Module 04's `PolicyService.GetActivePolicy`
      merge logic calling `GetActiveRule`). No gRPC server exists in this
      service yet, and neither Module 02 nor Module 04's own code has been
      touched. This module's own production readiness is explicitly gated on
      this cross-module work per §6 — Phase 4 is where it happens, not this
      one.
- [ ] **`RuleChangeImpactPreview`'s real simulation logic** and the
      `AuditLog` entry for "rule activated despite flagged non-compliant
      schedules." The table exists; nothing computes or reads it. Phase 5.
- [ ] **Async `generateComplianceReport`, all four report types, S3
      export.** No job queue, no S3 client, no report-generation logic of
      any kind exists in this service yet. `compliance_report.status`
      defaults to `pending` and stays there forever until Phase 6. Phase 6.
- [ ] **The retention/lifecycle `@Cron` job and `RetentionPolicy` seeding.**
      `idx_compliance_report_retention_expires_unheld` exists; nothing scans
      it. No `RetentionPolicy` row, platform-default or tenant-scoped, is
      seeded anywhere in this phase. Phase 7.
- [ ] **GraphQL surface** (`adherenceScores`, `occupancyTrend`,
      `shrinkageBreakdown`, `complianceRules`, all mutations). Not built at
      all in this phase — introduced alongside whichever phase first needs
      it (Phase 2 onward).
- [ ] **The §0.5 rollup-job-lag SLO and both §6 governance metrics
      (`ValidatePolicyAgainstFloor` rejection rate,
      impact-preview-flagged-but-activated-anyway rate) are declared but not
      measured**, because nothing that could violate or trigger them exists
      yet. Do not read a metric's existence as evidence the SLO is met or
      even measurable today.
- [ ] **Legal certification that any `ComplianceRule` correctly implements
      its cited regulation.** Out of scope for this module entirely, per
      the source spec's own explicit non-goals (§8) — this phase (and every
      later one) provides the citation-tracking mechanism and, eventually, a
      human-review gate; actual legal correctness stays a legal team's
      responsibility.
- [ ] **Terraform for real Postgres provisioning, Vault for credential
      issuance.** Same gap already flagged in every prior module's own
      Phase 1 checklist — not re-litigated per module.
- [ ] **In-process or gateway-level rate limiting, penetration testing /
      SOC2 / ISO27001, SAST / dependency scanning / SBOM.** Same explicit
      non-goals already stated platform-wide for Phase 1 of every module.
