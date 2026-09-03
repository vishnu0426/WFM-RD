# ADR-0105: `generateComplianceReport` - in-process async execution, CSV output, real S3/MinIO export, and jurisdiction resolution reuse

## Context
§3.2/§1: `POST /v1/compliance/reports` is explicitly async (returns a
`job_id`), covers four report types (`adherence_summary`, `overtime_audit`,
`rest_period_audit`, `regulator_export`), and exports to S3 (PDF/Excel per
the module prompt's literal wording; `.env.example` already declares
`COMPLIANCE_REPORTS_S3_BUCKET`, unused since Phase 1). Four real gaps
needed a decision before any code could be written - none had a precedent
anywhere in this platform to simply copy.

1. **No S3 (or any S3-compatible store) integration exists anywhere in
   this monorepo.** Every service, in both languages, was grepped for
   `aws-sdk`/`@aws-sdk/client-s3`/`boto3`/`minio` - zero hits. This is the
   platform's first.
2. **No PDF or Excel generation library exists anywhere either** (`pdfkit`,
   `exceljs`, `openpyxl`, etc. - none found), and no export feature of any
   kind (CSV or otherwise) exists to mirror.
3. **The only "submit via API, poll for a result" precedent is
   scheduling-service's `ScheduleJob`** - a separate OS process
   (`app/worker.py`) claiming rows via `SELECT ... FOR UPDATE SKIP LOCKED`,
   with a reaper for stuck jobs. That machinery exists because CP-SAT
   solving is CPU-bound and needs to run outside the request-serving
   process entirely (ADR-0060). Report generation here is I/O-bound
   (Postgres aggregation queries, a handful of gRPC calls, one S3 upload) -
   a fundamentally different workload profile.
4. **`overtime_audit`/`rest_period_audit`/`regulator_export` all need to
   know which jurisdiction's `ComplianceRule` to audit against** - the
   same gap ADR-0101/0102/0104 each hit and each resolved differently
   (write-time gate: caller supplies it; solve-time merge: resolved from
   `org_unit_id` via `CalendarService.GetWorkingTimeRules`; impact preview:
   caller supplies `orgUnitIds`).

## Decision

**Async execution stays in-process, fire-and-forget - no separate worker
process.** `POST /v1/compliance/reports` inserts a `pending`
`ComplianceReport` row and returns `{ id, status }` immediately; the actual
generation (`ComplianceReportService.generate`, private) is invoked
without being awaited by the request handler, updating the row to
`completed`/`failed` when it finishes. This is a deliberate, narrower
choice than scheduling-service's worker-pool pattern - justified by the
workload difference (I/O-bound, low-volume, admin-triggered vs. CPU-bound,
potentially-high-volume CP-SAT solves) - not an oversight. If report
volume or generation cost ever grows enough to need horizontal scaling or
crash-survivability across a process restart, the same claim-column +
separate-worker shape `ScheduleJob` already proves out is the obvious next
step; nothing here forecloses it, since the state machine
(`pending`→`completed`/`failed`, one row per job) is identical.

**Output format is CSV, not PDF/Excel.** No PDF/Excel library exists
anywhere in this platform to establish a convention from, and every report
type here is fundamentally tabular data - a real, useful, immediately
machine- and human-readable format needing no new heavyweight dependency
beyond the S3 client itself. PDF/Excel is a disclosed, real scope
reduction from §3.2's literal wording, not a silently cut corner - see the
production readiness checklist.

**S3 export is real** (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` -
this platform's first S3 dependency, in either language). `fileUri` stores
the canonical `s3://bucket/key` location; `GET /v1/compliance/reports/{id}`
additionally computes a presigned GET URL (1-hour expiry) on read, never
stored, since a stored presigned URL would silently expire without any
signal to the caller. Verified for real in this phase against a local
MinIO instance (S3-protocol-compatible, no real AWS account or cost
involved) via `COMPLIANCE_REPORTS_S3_ENDPOINT`/`_FORCE_PATH_STYLE`
overrides the real AWS SDK already supports natively for any
S3-compatible endpoint - not a mocked-only path.

**Jurisdiction resolution reuses Phase 3's existing machinery**:
`CalendarGrpcClientService.getWorkingTimeRules(tenantId, orgUnitId)` →
`countryCode`, the same call the timezone resolver already makes, not a
new capability. `orgUnitScope` is therefore **required** (not optional,
despite the schema's nullable column) for `overtime_audit`,
`rest_period_audit`, and `regulator_export` - each needs exactly one org
unit to resolve a jurisdiction against. `adherence_summary` has no such
requirement (`AdherenceScore` aggregates directly by `employeeId`, not
`orgUnitId`); `orgUnitScope` stays genuinely optional there, and when
provided, employee-to-org-unit filtering goes through
`EmployeeGrpcClientService.getSchedulableRoster`.

**`overtime_audit`/`rest_period_audit` reuse Phase 5's simulation module**
(`evaluate-schedule-compliance.ts`) against real published shift
assignments for the report's date range (`ScheduleQueryGrpcClientService`,
ADR-0103) and the org unit's actual active rule
(`ComplianceRuleService.getActiveRule`) - not a parallel audit engine. A
new `findViolations` export (alongside the existing boolean `isCompliant`)
returns the same per-rule-type checks' human-readable violation
descriptions instead of short-circuiting at the first one, since a report
needs the full list, not a yes/no.

## Consequences
- Module 08 gains its first external cloud dependency (S3) and this
  platform's first PDF/Excel-adjacent export feature (as CSV). Both are
  genuinely new architectural surface, not incremental additions to an
  existing pattern.
- A report generation failure after the row is already `pending` (a
  crashed process, an unhandled exception in `generate`) leaves the row
  stuck at `pending` forever - there is no reaper, unlike `ScheduleJob`'s.
  A real, disclosed gap given the in-process-async choice above; acceptable
  for this phase's admin-triggered, low-volume usage pattern, not
  acceptable if this feature scales up without revisiting the decision.
- `overtime_audit`/`rest_period_audit`/`regulator_export` cannot produce a
  tenant-wide (all-org-units) report - `orgUnitScope` is mandatory for
  them. A tenant wanting a multi-org-unit rollup must currently request
  one report per org unit.
- `regulator_export` is `overtime_audit` + `rest_period_audit`'s violation
  lists combined with the org unit's full active `ComplianceRule` set
  (including citations) - not a fifth, independently-designed report
  shape.
