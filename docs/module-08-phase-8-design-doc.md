# Module 08 Phase 8 Design Doc — Adherence & Compliance: Observability/Hardening

**Status:** Approved for implementation
**Owner:** Adherence & Compliance pod (Module 08), plus a two-line real
fix to root (`src/grpc/compliance-grpc-client.service.ts`,
`src/common/http/domain-error.filter.ts`).
**Scope:** §7's own closing line: "Phase 8 closes out this module's
8-phase build with observability/hardening." The last of the module's 8
phases - no further phases follow.

## Problem

Three real decisions, each about scope discipline as much as delivery:

1. **Two disclosed "surfaces as a generic 500" error-shape gaps** have sat
   unfixed since Phase 4/5 (`ComplianceGrpcClientUnavailableError`,
   `ScheduleQueryGrpcClientUnavailableError`) - cheap, low-risk, real.
2. **Should this phase add Prometheus alerting rules?** Multiple prior
   phases' checklists flagged "no alerting on metric X." Checking every
   sibling module's own Phase 8 confirms this is a platform-wide absence
   (no `rule_files`/`alerting` block anywhere, no Alertmanager container),
   not a Module 08-specific gap - see ADR-0107.
3. **Should this phase add a read API for `AdherenceScore`/`OccupancyRecord`/
   `ShrinkageRecord`?** True gap since Phase 1, never closed since nothing
   ever needed it. No sibling module's own Phase 8 closed an analogous
   gap - see ADR-0107.

## Decision

- **Fixed both error-shape gaps for real** (ADR-0107):
  `ComplianceGrpcClientUnavailableError` (root) and
  `ScheduleQueryGrpcClientUnavailableError` (Module 08) now extend their
  respective `DomainError` base classes, registered in both services'
  error-code→HTTP-status maps. Neither call site catches either
  specially, so only the error's *shape* changed, never its fail-closed
  *behavior*. Module 08's `DomainErrorFilter` - unit-tested for the first
  time across the whole build (13 cases) - also gained the two
  previously-GraphQL-only error registrations
  (`ImpactPreviewRequiredError`, and the newly-typed
  `ScheduleQueryGrpcClientUnavailableError`) on its REST path, for
  completeness.
- **No new Prometheus alerting rules** - matches every sibling module's
  own Phase 8, none of which added one either. The runbook and dashboard
  still document, in prose, what to check manually for every SLO/gap.
- **No new GraphQL/REST read queries for the rollup entities** - no
  precedent in any sibling module's own Phase 8 for closing this exact
  kind of gap in the hardening phase; left explicitly open and disclosed
  instead (the single largest standing gap named in both the runbook and
  this phase's checklist).
- **`docs/module-08-runbook.md`** - mirrors sibling modules' exact
  structure (flat numbered operational sections, each a concrete "how do
  I know this is really broken, what does a client see, how do I
  recover" answer with a real `curl`/SQL snippet, no formal "Architecture"/
  "Alerts" headings). Covers all four real external dependencies (core
  gRPC, scheduling-service gRPC, S3/MinIO, Postgres), all three `@Cron`
  jobs, and the Phase 7 tenant-id case-sensitivity bug's own shape (so a
  future regression is recognizable).
- **`observability/grafana-dashboard-module-08.json`** - mirrors sibling
  dashboards' exact schema (`schemaVersion: 39`, row + timeseries + text
  panels only, no templating variables, raw PromQL `expr`+`legendFormat`).
  One row per real declared metric group (rollup lag/runs, governance
  signals, rule lifecycle, reporting, retention lifecycle, HTTP, process
  health), plus a closing "Known observability gaps" text panel -
  matching Module 07's own convention of disclosing what the dashboard
  *can't* show rather than silently omitting it. Mounted into
  `docker-compose.yml`'s `grafana` service (the `-05`/`-06` dashboards'
  own pre-existing unmounted-gap is left as-is, not silently fixed here -
  out of this phase's own scope).

## Blast radius
- Root: `src/grpc/compliance-grpc-client.service.ts` (error class
  extends `DomainError`), `src/common/http/domain-error.filter.ts` (one
  new `STATUS_BY_CODE` entry). Both additive, zero existing callers of
  either error class found repo-wide before the change.
- Module 08: `src/grpc/schedule-query-grpc-client.service.ts` (same
  change), `src/common/http/domain-error.filter.ts` (two new
  `STATUS_BY_ERROR` entries), new
  `test/unit/common/http/domain-error.filter.spec.ts` (13 tests, this
  filter's first ever). New `docs/module-08-runbook.md`,
  `observability/grafana-dashboard-module-08.json`, one `docker-compose.yml`
  line. One new ADR (0107).
- Zero schema, migration, or business-logic changes - this phase is
  observability artifacts plus two error-shape fixes, nothing else.

## Verification

Real, running process for every claim below - Module 08 alone (`:8500`),
against the real local Postgres (no other service needed - neither the
error-shape fix nor the observability artifacts depend on any
cross-service call):

- `npx tsc --noEmit`/`npm run build` clean in both root and Module 08
  after the error-class changes.
- Root's `test/unit/employment-policies.service.spec.ts` (8 tests) and
  the full monorepo `npm test` (119 suites/671 tests) re-run clean after
  the root-side fix - confirming zero regression to the fail-closed
  behavior itself.
- Module 08's new `domain-error.filter.spec.ts` (13 tests) - every
  registered error class asserted against its expected HTTP status,
  plus the unregistered-fallback (500) and GraphQL-bailout paths.
- The real running service's `/metrics` endpoint scraped and confirmed
  to expose all nine Module-08-specific metric names this dashboard
  references (`# HELP`/`# TYPE` lines present for all nine; the one
  label-less counter, `compliance_impact_preview_flagged_but_activated_total`,
  shows a real `0` value line immediately on boot, while the eight
  labeled counters/histograms show no value line until first observed
  with a real label combination - normal `prom-client` behavior, not a
  defect, worth knowing when a freshly-deployed instance's dashboard
  looks emptier than an established one's).
- `process_resident_memory_bytes`/`nodejs_eventloop_lag_p99_seconds`/
  `http_request_duration_seconds_bucket` (the three generic panels)
  confirmed present with real, non-zero values from actual HTTP traffic
  generated during this same verification pass.
- A real `POST /v1/compliance/reports` (missing `orgUnitScope` on
  `overtime_audit`) and a real GraphQL `complianceRules` query both
  re-confirmed working correctly after the error-class changes -
  `/healthz`/`/readyz` both `ok`.
- `observability/grafana-dashboard-module-08.json` validated as
  well-formed JSON (`python3 -m json.tool`).
- Process killed and ports confirmed free afterward.

## Explicit assumptions (spec was ambiguous or silent here)
1. **No numeric SLO target exists for any metric besides the rollup job's
   own disclosed "~5 min" interpretation** (Phase 1/3's own code
   comment) - every other panel/row is presented as a governance/outcome
   signal to watch, not a threshold this build has any authority to
   assert as a literal spec-given number.
2. **"Hardening" does not mean "add alerting infrastructure" or "close
   every disclosed gap"** - matched to what every sibling module's own
   Phase 8 actually did, not an unbounded catch-all.
3. **The rollup entities' read-API gap is real but out of this phase's
   scope** - disclosed prominently (runbook, dashboard text panel, this
   checklist) rather than either silently ignored or unilaterally fixed
   without a design precedent to follow.

## Out of scope for this phase (do not build yet - and no further phase exists to do it in)
- Prometheus alerting rules of any kind.
- GraphQL/REST read queries for `AdherenceScore`/`OccupancyRecord`/
  `ShrinkageRecord`.
- Latency histograms for `ValidatePolicyAgainstFloor`, impact-preview
  generation, report generation, or the retention lifecycle tick.
- An audit trail for `legal_hold` changes.
- A reaper for a `generateComplianceReport` job stuck at `pending` after
  a crash.
- Fixing the tenant-id case-sensitivity bug pattern in any sibling
  service - found and fixed in Module 08 only (Phase 7), disclosed as
  likely present elsewhere, never chased further.
- RBAC/permission checks anywhere in this module - §8's own explicit
  non-goal from the module's very first phase, unchanged through its
  last.
