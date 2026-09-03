# Module 02 Runbook — Org & Employee Management

Operational reference for everything Module 02 runs outside a direct request/
response cycle: the nightly skill-decay job, the outbox publisher, bulk HRIS
import jobs, and the GDPR erasure workflow. There is no metrics/dashboards
backend anywhere in this repository as of Phase 8 - every check below is a
direct SQL query against the tables the relevant service already writes, run
as the `agno_migrator` role (or any role with `SELECT` on `org`/`core`).

## 1. Nightly skill-decay job (§5, ADR-0017)

**What it is:** `SkillDecaySchedulerService.tick` (`@Cron('*/15 * * * *')`)
finds every `active` tenant and, for each, checks whether it's currently
`02:00` in that tenant's default `WorkingTimeCalendar.timezone` (UTC if none
set). If so, it calls `SkillDecayJobService.runForTenant`, which processes
that tenant's employees in resumable, checkpointed batches and writes one
`org.decay_job_runs` row per `(tenant_id, run_date)`.

**Is it healthy?**
```sql
SELECT tenant_id, run_date, status, employees_processed, failures_count, started_at, completed_at
FROM org.decay_job_runs
ORDER BY started_at DESC
LIMIT 20;
```
- A tenant with no row for the last local calendar day never entered its
  `02:00` window, or the scheduler tick itself is not running - check process
  logs for `SkillDecaySchedulerService`, not this table.
- `status = 'running'` with a `started_at` more than a few hours old and no
  progress in `last_processed_employee_id` (compare across repeated queries)
  indicates a stuck run - the job is resumable (ADR-0017), so it is safe to
  investigate and, if genuinely stuck, let the next `02:00` window re-pick-up
  from the last checkpoint rather than manually deleting the row.
- `failures_count > 0` on an otherwise `completed` run means some employees'
  decay scores were skipped, not that the whole run failed - cross-reference
  against application logs for the specific employee IDs.

**Certification alerts:** `SkillDecayJobService` also emits `SkillExpiring`
outbox events (§5, log-only today - see §2 below on the outbox itself, and
the Phase 4 checklist for why there is no actual notification delivery yet).

## 2. Outbox publisher / NATS JetStream (ADR-0019)

**What it is:** `OutboxPublisherService.tick` (`@Cron('*/10 * * * * *')`,
every 10 seconds) polls `org.outbox_events` for unpublished rows across all
tenants, publishes each to NATS JetStream, and marks `published_at`. Failed
publishes increment `attempts`/`last_error`; after 5 attempts a row is routed
to the `agno.org.dlq.v1` subject (still recorded as unpublished in Postgres -
NATS delivery, not the DB row, is what "gave up" means here).

**Is it healthy?**
```sql
SELECT subject, count(*) FILTER (WHERE published_at IS NULL) AS backlog,
       count(*) FILTER (WHERE published_at IS NULL AND attempts >= 5) AS dead_lettered,
       max(created_at) FILTER (WHERE published_at IS NULL) AS oldest_unpublished
FROM org.outbox_events
GROUP BY subject;
```
- A growing `backlog` with `oldest_unpublished` more than a couple of minutes
  old means NATS is unreachable or slow - `NatsClientService` has a 5-second
  reconnect cooldown and a 1-second connect timeout specifically so a down
  NATS doesn't stall the whole publisher tick (see the connection-handling
  note in `nats-client.service.ts`), but a backlog still means events aren't
  reaching consumers (Scheduling/Forecasting) in anything close to real time.
- `dead_lettered > 0` needs a human to look at `last_error` on those specific
  rows and decide whether to fix-and-manually-republish or accept the loss -
  there is no automated replay tooling for the DLQ today.
- This same table is how Phase 8's erasure completion event
  (`eventType: 'erased'`) reaches consumers - if erasure completions are
  succeeding (see §4) but the affected org unit's cached schedulability data
  isn't refreshing downstream, check here first.

## 3. Bulk HRIS import (§3.2, ADR-0020)

**What it is:** `POST /v1/employees/bulk-import` returns `202` + a
`org.bulk_import_jobs` row immediately; the actual create/update work runs
async. `dryRun: true` (the default) computes and stores a diff without
writing any `Employee` rows; committing writes is gated by the
per-tenant `org.feature_flags` row for bulk import.

**Is it healthy?**
```sql
SELECT id, tenant_id, status, dry_run, records_total, records_succeeded, records_failed, created_at, completed_at
FROM org.bulk_import_jobs
WHERE status IN ('pending', 'running')
ORDER BY created_at ASC;
```
- A job stuck in `pending`/`running` for longer than its `records_total`
  would plausibly take (this is a synchronous in-process async job, not a
  queue-backed worker - see the Phase 6 checklist for that limitation) most
  likely means the process that started it crashed or restarted mid-job;
  there is no automatic resume for a bulk import job today (unlike the decay
  job) - it needs to be re-submitted.
- `GET /v1/jobs/:id` (or the same query above by `id`) is the poll contract
  clients are expected to use - there is no push/webhook notification on
  completion.

## 4. GDPR erasure workflow (§2.4/§8, ADR-0011/ADR-0022)

**What it is:** `ErasureRequest` moves `pending -> approved -> completed`
(or `-> rejected` from either `pending` or `approved`). Completion is
synchronous, not a background job - it runs inline inside the
`completeErasureRequest`/`POST /v1/erasure-requests/:id/complete` call and
either fully succeeds (entity scrub + status flip + audit log + outbox event,
one transaction) or fully fails with no partial effect.

**Is it healthy?**
```sql
-- Requests stuck in an intermediate state longer than expected
SELECT id, tenant_id, employee_id, status, requested_at, completed_at
FROM org.erasure_requests
WHERE status IN ('pending', 'approved')
ORDER BY requested_at ASC;

-- Confirm a specific completion actually anonymized what it claims to
SELECT resource_id, before_state, after_state, created_at
FROM core.audit_log
WHERE action = 'employee.erasure.completed' AND resource_id = '<employee_id>';
```
- A `pending`/`approved` request sitting for a long time is not itself a bug
  - there is no SLA on human approval, and that's intentional (§2.4/§9: legal
  sufficiency is not this codebase's decision to automate).
- If `AuditLog` has no `employee.erasure.completed` row for a given
  `employee_id` but `org.employees.employee_number` for that row already
  matches `^ERASED-`, something bypassed the service layer (e.g. a manual
  `UPDATE` run directly against Postgres) - the transactional design means
  this should not be reachable through the API.
- **Never** query for the pre-erasure `employee_number` to "confirm what was
  erased" - by design, nothing in this system retains it after completion.
  If that value is needed for a compliance investigation, it has to come from
  a source outside this database (e.g. an external HRIS record retained
  under a different retention policy), not from here.

## Standing gaps this runbook does not paper over

No authentication (ADR-0014/ADR-0021), no RBAC/ABAC, no load testing against
the §0.5 targets, and no real metrics/dashboards backend - see the Phase 8
design doc and production readiness checklist for the full list. This
runbook tells you how to check health with the tools that actually exist
today; it is not a substitute for building the ones that don't.
