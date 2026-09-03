# Module 09 Phase 8 (Final) Production Readiness Checklist

This is Module 09's **final** phase. Like Module 08, Phases 1-7 of this
module each produced their own standalone design doc + checklist - this
document covers what Phase 8 itself delivered, then indexes the real,
still-open gaps named across all seven prior phases' own ADRs
(0108-0111) without re-deriving them, followed by a closing summary of
what Module 09 actually is, end to end.

## Delivered in this phase

- [x] **`MvConsistencyCheckJobService`** (§2.3 rule 4, ADR-0112) - a
      real, scheduled (`0 4 * * *`) sampling job across all four `mv_*`
      views, sharing the refresh jobs' own two pools. 11 new unit tests.
      **Live-verified against real Postgres primary + a real streaming
      replica**: caught a genuine drift case (source rows from an
      earlier phase's own verification no longer present on the
      replica) and, separately, a real bug in the verification harness
      itself (a missing `TimeZone=UTC` session setting causing false
      positives) - both resolved before trusting the result. A clean
      re-run showed zero discrepancies; a manually-injected bad value
      was correctly detected, logged, and reverted.
- [x] **Load test** (`scripts/load-test.ts`, no new npm dependency,
      matching the exact Module 04/05/07 precedent) - 500 concurrent
      `metricQuery`/`executiveSummary` reads: zero failures, every call
      landed in the real server-side ≤25ms histogram bucket (well
      inside the disclosed `CHEAP_THRESHOLD_MS` = 100ms stand-in
      target). 10 concurrent `POST /v1/analytics/exports`, run against
      a real local MinIO instance stood up specifically for this
      phase: 10/10 completed for real, p99 completion latency 59.0ms -
      the first time this async export path has been exercised under
      concurrent load. Full numbers in
      `docs/module-09-phase-8-load-test-results.md`.
- [x] **`docs/module-09-runbook.md`** - real operational scenarios
      (primary down, replica lagging/unreachable including a real
      ~32-minute lag independently found on this build's own dev
      replica, a refresh job lagging/failing, a consistency-check
      discrepancy found, S3/MinIO down for exports, `askAnalyticsQuestion`'s
      by-design-always-fails posture, migration rollback), matching
      every sibling module's own runbook format.
- [x] **`observability/grafana-dashboard-module-09.json`** - one row
      per real declared metric group (MV freshness, replica health +
      consistency-check, query engine by cost tier, async exports,
      HTTP/GraphQL, process health), plus a closing "Known
      observability gaps" text panel, validated as well-formed JSON.
      Wired into `docker-compose.yml`'s `grafana` service.
- [x] **Checked for cheap error-shape fixes** (Module 08's own Phase 8
      precedent) and found none needed - the one raw `throw new Error`
      in this module (`export-storage.service.ts`'s `parseS3Uri`) is a
      parse-assertion on this service's own internally-generated data,
      never reachable from caller input.
- [x] ADR-0112 - this phase's own scope decisions written explicitly,
      including two real findings from live verification (the drift
      case and the harness timezone bug) and why "hardening" was
      matched to sibling-module precedent rather than treated as an
      unbounded catch-all.
- [x] 147 unit tests total (up from 136 in Phase 7), all passing.
      `npx tsc --noEmit`/`npm run build`/`npm run lint` clean.

## Explicitly NOT done here (a deliberate scope boundary for this phase, not an oversight)

- [ ] **No Prometheus alerting rules** - confirmed platform-wide absence
      (no sibling module's own final phase added one either).
- [ ] **`EXPORT_MAX_ROWS`/`MAX_LIMIT` were not load-tested near their own
      numeric ceiling** - this run's real data volume is a few dozen
      rows per view (this build's own prior-phase fixtures); no
      synthetic bulk-data generator exists anywhere in this platform to
      produce a production-scale dataset honestly.
- [ ] **No real Module 10 implementation** - `askAnalyticsQuestion`
      remains real and callable but always returns
      `NL_QUERY_BRIDGE_UNAVAILABLE` (ADR-0111). Out of this module's own
      scope regardless of phase.

## Module-wide standing gaps (indexed from every prior phase's own ADR, not re-derived)

- [ ] **`askAnalyticsQuestion` never returns a real answer** - Module 10
      does not exist anywhere in this platform (ADR-0111). The single
      largest functional gap in this module as of Phase 8, and the one
      most clearly out of this module's own power to close.
- [ ] **No pay-rate/budget capability exists anywhere in this
      platform** - `mv_cost_vs_budget` reports hours and days, never a
      dollar figure (ADR-0109). Despite the table's own name.
- [ ] **No real attrition rate** - `mv_attrition_by_site` reports
      `terminations_count` only; a real rate needs a historical
      point-in-time headcount denominator this platform doesn't have.
- [ ] **`createScheduledExport`** (a recurring export tied to a
      `SavedReport` config) was never built - only the one-shot
      `POST /v1/analytics/exports` exists (Phase 6). No phase in this
      module's own build-phase list was ever explicitly assigned to
      build it.
- [ ] **No reaper for a `generate` (export) job stuck at `pending`**
      after a process crash - the same in-process fire-and-forget
      trade-off Module 08's own report generator accepts.
- [ ] **No retention/lifecycle job for old exports** - no
      `analytics_export` row or its S3 object is ever deleted.
- [ ] **No RBAC/permission check anywhere in this module** - creator-only
      authorization (`requestedBy`/`createdBy === actorId`) for
      dashboards and exports is the only access control that exists;
      no Module 01 RBAC/sharing integration anywhere.
- [ ] **Tenant-authored custom metrics are named views onto the
      whitelist, never arbitrary formulas** (ADR-0110) - a deliberate
      scope narrowing from what "custom metrics" might otherwise imply.
- [ ] **No PDF/Excel export output** - CSV only, matching Module 08's
      own precedent and disclosed scope reduction.
- [ ] **Real AWS S3 was never exercised** - all S3 verification
      (Phases 6 and 8) used a local MinIO instance. The
      `@aws-sdk/client-s3` code path itself is real and would work
      unmodified against real AWS (same client, same calls, only the
      endpoint/credentials differ), but that specific combination was
      never actually run.
- [ ] **This build's own local dev read replica drifted to a real
      ~32-minute lag** after sitting idle since an earlier phase's
      verification session - independently found during this phase's
      own live verification, disclosed in the runbook rather than
      silently worked around. Not itself a code defect, but a real
      environment fact worth knowing before trusting a "replica caught
      up" assumption in this local setup.
- [ ] **Terraform/Vault, penetration testing, SAST/SBOM, real
      production-scale load testing** - the same explicit non-goals
      stated platform-wide for every module, restated (not newly
      discovered) here.

## Summary: what Module 09 actually is, end to end

The platform's analytics/reporting read surface, built on Postgres read
replicas plus this module's own materialized views instead of the
platform-banned ClickHouse/Kafka architecture the original spec's §0.6
called for (Phase 1, ADR-0108) - a real, disclosed architectural
substitution, not a silent scope cut. Four real materialized views
(adherence trend, forecast accuracy, cost-vs-budget-as-hours-and-days,
attrition-by-site), each refreshed nightly by its own idempotent
cross-tenant job and independently sampled against fresh source reads by
a real consistency-check job (Phases 2/3/8). A real, whitelist-secured
query engine (`SOURCE_VIEW_REGISTRY`) serving `metricQuery`/
`executiveSummary`/a REST BI-connector endpoint, backing real dashboards
with real widget-level cost-tier gating (Phase 4). A real, tenant-authored
custom-metric pipeline with a genuine dry-run cost-validation gate before
any tenant-supplied calculation is trusted (Phase 5, ADR-0110). A real
async CSV export job with genuine `Idempotency-Key` handling and real
S3/MinIO integration, verified end to end including under concurrent
load (Phases 6/8). A real, fully-wired natural-language question bridge
whose only honest limitation is that the other side of it (Module 10)
does not exist yet (Phase 7, ADR-0111) - everything on this module's own
side of that boundary is real and proven. Eight phases, five ADRs
(0108-0112), one runbook, one dashboard, and a real load test and
consistency-check job proven against real Postgres, a real streaming
replica, and real MinIO - not mocked, not simulated - with the honest
gaps above naming exactly where a human should look next, the
NL-query-bridge gap being the one most clearly outside this module's own
power to close.
