# Module 08 Phase 8 (Final) Production Readiness Checklist

This is Module 08's **final** phase. Unlike Module 07, Phases 1-7 of this
module each produced their own standalone design doc + checklist - this
document covers what Phase 8 itself delivered, then indexes the real,
still-open gaps named across all seven prior phases' own ADRs (0093-0106)
without re-deriving them, followed by a closing summary of what Module 08
actually is, end to end.

## Delivered in this phase

- [x] **Two real error-shape fixes**: `ComplianceGrpcClientUnavailableError`
      (root) and `ScheduleQueryGrpcClientUnavailableError` (Module 08) now
      extend their respective `DomainError` base classes - a typed error
      code at the REST/GraphQL boundary instead of a generic 500, flagged
      as a disclosed gap since the phases that introduced them (4/5) and
      never fixed until now. Fail-closed *behavior* was already correct
      and unaffected.
- [x] **`DomainErrorFilter`'s first-ever dedicated unit test** (13 cases) -
      this filter had none across 7 phases of real E2E-curl-verified-but-
      never-unit-tested behavior.
- [x] **`docs/module-08-runbook.md`** - real operational scenarios (core
      gRPC outage, scheduling-service gRPC outage, S3/MinIO outage, rollup
      job lag/failure, retention lifecycle failure, the Phase 7 tenant-id
      case bug's own recognizable shape, migration rollback), matching
      every sibling module's own runbook format exactly.
- [x] **`observability/grafana-dashboard-module-08.json`** - every metric
      this service actually emits, across all 9 module-specific
      Prometheus series plus the 3 generic ones, validated as
      well-formed JSON and cross-checked against a real running
      instance's real `/metrics` output (every metric name this
      dashboard references confirmed present in real scrape output).
      Wired into `docker-compose.yml`'s `grafana` service.
- [x] ADR-0107 - this phase's own scope decisions (why no alerting rules,
      why no new read API, the two error-shape fixes) written explicitly,
      including why each *not*-done item was judged out of scope rather
      than silently skipped.

## Explicitly NOT done here (a deliberate scope boundary for this phase, not an oversight)

- [ ] **No Prometheus alerting rules** - confirmed platform-wide absence
      (no sibling module's own Phase 8 added one either); adding one for
      Module 08 alone would be inconsistent with every sibling module's
      own closing phase, not catching up to a missed convention.
- [ ] **No new GraphQL/REST read query for `AdherenceScore`/
      `OccupancyRecord`/`ShrinkageRecord`** - see the module-wide gap
      below; no sibling module's own Phase 8 closed an analogous gap,
      and building a new read API in the platform's designated hardening
      phase, with no precedent, would be scope invention.
- [ ] **No new latency histograms** (`ValidatePolicyAgainstFloor`, impact
      preview, report generation, retention tick) - only outcome counters
      exist for all four; adding real histograms now, this late, without
      the literal §0.5 numeric targets this build was never given for any
      of them, risked inventing false-precision SLOs.

## Module-wide standing gaps (indexed from every prior phase's own ADR, not re-derived)

- [ ] **`AdherenceScore`/`OccupancyRecord`/`ShrinkageRecord` have no read
      API anywhere - the single largest functional gap in this module as
      of Phase 8.** True since Phase 1 (deferred as "introduced alongside
      whichever phase first needs it"); no phase ever needed it, so it
      was never built. The rollup jobs (Phase 3) compute real data that,
      as of this module's last phase, only direct SQL access can ever
      read back.
- [ ] **Jurisdiction resolution is country-level only, everywhere it's
      used** (`OrgUnit.countryCode`) - no state/subdivision precision at
      any of the four integration points this module built
      (ADR-0101/0102/0104/0105). A tenant needing "US-CA" precision must
      supply `jurisdiction` explicitly where that's even possible
      (Module 02's write-time gate only); no override exists anywhere
      else.
- [ ] **`overtime_threshold` floors are enforced only by Module 02's
      write-time gate** (ADR-0101) - never merged into Module 04's
      `EmploymentPolicy` (ADR-0102, no corresponding field exists) and
      never simulated in Phase 5/6's schedule-based checks (ADR-0104/0105,
      no schedule-derivable multiplier signal).
- [x] ~~No RBAC/permission check anywhere in this module~~ - **closed by
      ADR-0161**: this module's first RBAC infrastructure (`src/auth/`, own
      copy of integration-hub-service's/ai-layer-service's identical guard
      trio, ADR-0145/ADR-0130) now gates every write path -
      `createComplianceRule`/`activateComplianceRule`/
      `generateRuleChangeImpactPreview` (`compliance_rule:write`),
      `generateComplianceReport` (`compliance_report:write`),
      `PATCH .../legal-hold` (`compliance_report:approve` - a materially
      higher-stakes action than generating a report, given its own
      permission rather than folded into `:write`) - plus both read
      surfaces (`complianceRules`/`GET .../rules/{jurisdiction}`,
      `GET .../reports/{id}`, `compliance_rule:read`/`compliance_report:read`).
      `compliance_rule`/`compliance_report` permissions were added to
      core's seed (`src/database/seeds/run-seed.ts`) - no local permissions
      table exists in this service's own schema, same as every other
      remote-JWKS-resource-server module in this platform.
- [ ] **PDF/Excel report output was never built** - CSV only (ADR-0105),
      a real, disclosed scope reduction from §3.2's literal wording.
- [ ] **No reaper for a `generateComplianceReport` job stuck at `pending`
      after a process crash** (ADR-0105's in-process, no-separate-worker
      design) - a real, disclosed trade-off versus scheduling-service's
      `ScheduleJob` worker-pool precedent.
- [ ] **No audit trail for `legal_hold` changes** - who placed/removed a
      hold, or why, is not recorded anywhere (ADR-0106), despite
      `AuditGrpcClientService` already being wired into this service
      since Phase 5.
- [ ] **`RetentionPolicy` coverage is minimal** - one seeded platform-
      default `US`/3-year row (ADR-0106); every other jurisdiction falls
      to a disclosed 7-year hardcoded fallback (ADR-0105/Phase 6).
- [ ] **The tenant-id case-sensitivity bug (found and fixed in Module 08,
      Phase 7/ADR-0106) was never verified or fixed in any sibling
      service** - each almost certainly carries an identical copy of
      `TenantContextMiddleware` with the identical gap.
- [ ] **No manual-trigger endpoint for the retention lifecycle sweep** -
      real verification (Phase 7) used a standalone script instantiating
      the job's dependencies directly; there is no operational way to
      force a sweep on demand in the running service.
- [ ] **Real AWS S3 was never exercised** - all S3 verification
      (Phase 6/7) used a local MinIO instance, per explicit user choice.
      The `@aws-sdk/client-s3` code path itself is real and would work
      unmodified against real AWS (same client, same calls, only the
      endpoint/credentials differ), but that specific combination was
      never actually run.
- [ ] **Terraform/Vault, penetration testing, SAST/SBOM, legal
      certification of any `ComplianceRule`'s correctness** - the same
      explicit non-goals stated platform-wide for every module, restated
      (not newly discovered) here. §8's own non-goal list: no legal
      certification, no rewriting Module 02/04's own internal logic
      beyond the integration points, no Kafka/ClickHouse.

## Summary: what Module 08 actually is, end to end

The platform's single source of truth for labor-law thresholds
(`ComplianceRule`, nullable-tenant-id platform-default/tenant-override
model, ADR-0095/0097) - real, working, bidirectional integration into
both Module 02's `EmploymentPolicy` write path (a hard rejection gate,
ADR-0101) and Module 04's solve-time policy merge (stricter-wins-per-field,
ADR-0102), not a standalone table nobody else reads. A real, disclosed
rollup pipeline (Phase 3, ADR-0098/0099) computing `AdherenceScore`/
`OccupancyRecord`/`ShrinkageRecord` with genuine per-employee timezone
correctness - whose own output, as of this final phase, nothing outside
direct SQL can read back (this module's single largest standing gap). A
real rule-change impact simulation (Phase 5, ADR-0103/0104) that re-runs
the actual constraint arithmetic against real published schedules before
a legal-floor change goes live, gated by a mandatory-but-advisory review
step with a real audit trail for the flagged-but-activated case. Real,
working async compliance reporting (Phase 6, ADR-0105) - four report
types, genuine S3 export (this platform's first), verified against a
real MinIO instance end to end, not mocked. A real, working retention
lifecycle (Phase 7, ADR-0106) - a legal-hold-guarded scheduled hard
delete, S3-object-then-Postgres-row ordered for crash safety, verified
against real backdated data. Eight phases, fifteen ADRs (0093-0107), one
runbook, one dashboard, and a real, pre-existing platform bug (tenant-id
case-sensitivity) found and fixed along the way, not just theorized
about - the gaps above are the honest, named boundary of what this
module does not yet solve, with the unqueryable rollup data the one most
worth prioritizing next.
