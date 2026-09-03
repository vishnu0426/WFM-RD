# ADR-0052: `scheduling` schema in the shared `agno_wfm` database, served by a new `agno_scheduling_app` role

## Context
Module 04 is a second Python/FastAPI service (Module 03 was the first). The same
two questions ADR-0017 already settled for Module 03 apply again: separate
database or a new schema in the existing one, and does it authenticate as an
existing role or a new one. Module 04's own module prompt (§1) additionally
mandates OR-Tools CP-SAT as the constraint solver and NATS JetStream as the
event backbone — both are library/infra choices orthogonal to this question,
not new arguments for either side.

## Decision
Same answer as ADR-0017, for the same reasons: `scheduling` schema in the
existing `agno_wfm` database, `AUTHORIZATION agno_migrator`. A **new**
`agno_scheduling_app` runtime role, granted `USAGE` on `scheduling` only — not
`core`, not `org`, not `forecasting`. Per the module prompt's §2/§4.3 bounded-
context rule, this module reads Module 01/02/03 data exclusively through their
gRPC contracts (`GetSchedulableEmployees`, `GetForecastRequirements`,
`GetActiveEmploymentPolicies` — wired in a later phase), never by reading
another schema's tables directly, so there is no cross-schema grant to make.

## Consequences
- `scripts/init-roles.sql` gains one role and one schema grant block, matching
  the block ADR-0017 added for `agno_forecasting_app` line for line; zero
  changes to any existing role's grants.
- Tenant isolation reuses Module 01's `app.current_tenant_id` GUC convention
  unchanged (ADR-0002), `ENABLE`-not-`FORCE` RLS for the same reason ADR-0017
  gives: `agno_migrator` owns every table here, `agno_scheduling_app` never
  does, so plain `ENABLE` already binds the runtime role unconditionally.
- `ScheduleJob.forecast_run_id` and every employee/skill id this module stores
  (`ShiftAssignment.employee_id`, `ScheduleConflict.affected_employee_id`, …)
  are plain `uuid` columns with **no** foreign key into `forecasting.*` or
  `org.*` — a literal SQL `REFERENCES` across those schemas would be a
  stronger coupling than the gRPC-contract boundary the module prompt
  describes, and would silently break the moment Module 03/02 change a column
  this module was never supposed to read directly. Referential correctness
  for those ids is a gRPC-contract concern, not a Postgres one.
- If this platform later moves to per-service databases, this ADR (like
  ADR-0017) is the thing that gets revisited; nothing in the RLS/GUC design
  is database-count-dependent.
