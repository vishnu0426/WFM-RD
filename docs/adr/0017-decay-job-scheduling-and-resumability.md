# ADR-0017: Nightly skill-decay job - checkpointed batches, tenant-local scheduling, log-only certification alerts

## Context
§5 names four requirements together: a per-tenant-local-time trigger (not one global UTC
run), resumability/idempotency "safe to re-run or resume mid-failure per employee,"
an explicit decay function with a tenant-configurable half-life, and certification
alerts that "integrate with Module 01's `NotificationPreference` to actually notify
the relevant manager/HR admin, not just update a database column silently." Each of
these needed its own concrete decision.

## Decision: checkpointed batches via `DecayJobRun`, not one giant transaction
`org.decay_job_runs` (one row per `(tenant_id, run_date)`) is the resumability
checkpoint: `lastProcessedEmployeeId` is the cursor, `employeesProcessed`/
`failuresCount` accumulate across resume attempts. `SkillDecayJobService.runForTenant`
is idempotent (a `completed` run for that date is a no-op) and resumable (a `running`/
`failed` run continues from its checkpoint, via `EmployeesRepository.findIdsPage`
cursor pagination ordered by `id`). This mirrors `AuditLog`'s and the SCD history
tables' precedent of choosing DB-verifiable state over trusting a job runner's own
retry semantics - the checkpoint lives in the same database the work touches, in the
same transaction as the work's own writes, so "did batch N actually commit" is never
ambiguous even across a hard process crash.

## Decision: `PARTITION BY HASH` batch size and bulk SQL, not per-employee updates
Each batch's decay recompute is one `UPDATE ... WHERE employee_id = ANY($ids)`
(`EmployeeSkillsRepository.applyDecayForEmployees`), not N per-row updates - consistent
with `Employee`/`EmployeeSkill` being `HASH`-partitioned by `tenant_id` (ADR-0010) for
exactly this kind of bulk, tenant-scoped write pattern.

## Decision: fixed tenant-local 02:00 window, not a fully configurable schedule
`SkillDecaySchedulerService` ticks every 15 minutes and, for each active tenant,
computes tenant-local time from `WorkingTimeCalendar.timezone` (added in this phase's
migration - see that file's own comment for why the column didn't already exist) and
runs when the local hour is 2. The window's *hour* is a fixed constant
(`DECAY_JOB_LOCAL_HOUR`), not itself a per-tenant setting - §5 says "default 02:00
tenant-local," and building real per-tenant configurability would mean another schema
field and its own CRUD surface, which is scope §5 doesn't actually ask for beyond the
timezone-awareness itself. Cross-tenant enumeration (`findActiveTenants`) uses a
platform-admin `TenantContextService` session bound to a nil-UUID placeholder tenant
id, since `core.tenants`' RLS (ADR-0007) only grants full visibility to
`is_platform_admin` sessions, and there is no "real" tenant this batch process runs as.

## Decision: certification alerts are logged, not dispatched
`logExpiringCertificationAlerts` (run after each `runForTenant` completes) does real
work: it finds expiring `EmployeeSkill` rows, resolves the affected employee's manager
via `EmployeeHistory`, and looks up that manager's actual `NotificationPreference` rows
filtered to `eventType: 'skill_expiring'` and `enabled: true` - genuine data, not a
placeholder. It does not deliver anything. No email/SMS/push mechanism exists anywhere
in this repo (Module 01 has never built one), and `SkillExpiring` NATS publishing is
explicitly Phase 6. Logging at `warn` with the resolved recipient/channel list is the
honest stopping point: it proves the "who to notify" logic is correct without
pretending a send happened that didn't.

## Consequences
- `PolicyType.SKILL_DECAY_HALF_LIFE` extends `core.policies` again (ADR-0012's
  precedent) rather than a new column - tenant-wide only (`orgUnitId` left null),
  since §5 says "tenant-configurable," not org-unit-scoped. No configured policy ->
  `DEFAULT_HALF_LIFE_DAYS` (180) applies.
- `RunOptions.maxBatches` on `runForTenant` is a test-only hook (stop after N batches,
  leaving the run `running` rather than `completed`) to deterministically simulate the
  "job fails halfway through" chaos scenario (§0.5) without needing to actually crash
  a process mid-run.
- The scheduler's own top-level per-tenant `try/catch` (in `tick()`) means one tenant's
  failure can never wedge the rest of that tick's run - each tenant's own failure is
  already durable in its `DecayJobRun` row regardless.
- Real metrics/paging on overrun or failure (§5's own observability requirement) do not
  exist - `Logger` calls are the only signal today. See the production readiness
  checklist.
