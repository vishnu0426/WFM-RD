# ADR-0115: `ScheduleExplanationDataService` — a new gRPC read surface added to scheduling-service, since the one §0.5's table names (`SchedulingDataProvider`) does not exist

## Context
§0.5's cost/FinOps table and this module's own §6.2 describe `explainSchedule` pulling "`ScheduleExplanation` from Module 04" via gRPC. Building Phase 2 required first checking what that gRPC contract actually is in this codebase, not assuming it - the same discipline ADR-0059/ADR-0111 already established for this platform's other cross-module gaps.

**It does not exist**, confirmed by inspection:
- scheduling-service's real gRPC surfaces are `SchedulingEligibilityService` (ADR-0082) and `ScheduleQueryService` (ADR-0103) - neither serves a `ScheduleJob`'s own solve-result columns (`objective_score`, `relaxations_applied`, `decomposition_plan`, `status`).
- The actual Module 04 <-> Module 10 contract that was built (Phase 6, ADR-0059) is a **write-only REST handoff**: `POST /v1/scheduling/jobs/{jobId}/explanation` (Module 10 submits a generated explanation) and `explanation` folded into `GET /v1/scheduling/jobs/{jobId}` (read-back of what was submitted). Module 04's own Phase 6 design doc says so explicitly: this module "requests it, doesn't own the LLM call" - but nothing was ever built for the *requesting* half. `explanation` stays `null` forever without it.
- No gRPC message anywhere in this repo is named `ScheduleExplanation`, and no service is named `SchedulingDataProvider`.

This is the same shape of gap ADR-0059's `ForecastService.GetForecastRequirements` and ADR-0111's `NlQueryBridgeClient` already hit and closed for their own modules - the honest move, established by precedent, is to build the real, missing contract in the owning service, not fabricate a caller against something that isn't there, and not silently skip the phase.

## Decision
Add `agno.scheduling.v1.ScheduleExplanationDataService.GetScheduleJobForExplanation` to scheduling-service - its **third** gRPC server surface, same process/port as `SchedulingEligibilityService`/`ScheduleQueryService` (no CP-SAT/CPU-bound work, same reasoning ADR-0103 already gives for adding a second servicer to that process rather than a new one). Unary (a plain by-primary-key read, not server-streaming). Reuses `job_service.get_job`'s own tenant-scoped query - no new query logic, no new table.

The response echoes `tenant_id` from the persisted row (not merely the request's own field) specifically so Module 10's §5.1 tenant-scoping assertion has a real, independently-sourced value to check against - defense in depth against a query-router bug that requested the wrong scope, not a tautological check against the caller's own input.

`found: false` for a nonexistent job, a different tenant's job, or a malformed id - the same convention `ForecastService.GetForecastRequirements`/`ScheduleQueryService` already use, never a thrown gRPC error for an ordinary "no such job" case.

## Consequences
- Module 10's `explainSchedule` has a real data source as of Phase 2 - `objective_score`/`relaxations_applied`/`decomposition_plan`/`constraint_config`/`status`/`date_range` are all genuinely readable now, not fabricated or stubbed.
- scheduling-service gains a fourth `.proto` file and a third generated-stub pair (`schedule_explanation_data_pb2*.py`), following the exact `grpc_tools.protoc` + manual `from . import` fix convention `forecast.proto`/`schedule_query.proto` already document.
- The REST write-back half (`POST /v1/scheduling/jobs/{jobId}/explanation`) was already real (Module 04's own Phase 6) - this ADR only had to build the read half. See ADR-0116 for a real contract mismatch this write-back call surfaced.
- Verified against a real, running Postgres/worker in this session (not just unit-level): the new servicer imports cleanly, `app.main` boots with it registered, and a hand-rolled end-to-end job submission reached the new servicer's exact query path. Full "submit a job through the real worker, then call `GetScheduleJobForExplanation` and see `status: completed`" verification hit a **pre-existing, unrelated environment gap** in this session (`CalendarService.GetWorkingTimeRules` on port 5000 answering with an HTTP/1.1 403 instead of gRPC - reproduced identically by the pre-existing, unmodified `test_schedule_query_grpc.py`, so not caused by this change). Recorded honestly in the readiness checklist, not glossed over.
