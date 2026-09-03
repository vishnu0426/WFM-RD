# Module 04 Phase 7 - decomposition load test results

Generated 2026-08-07T06:12:45.483462+00:00 by `scripts/load_test_decomposition.py` against a real local Postgres/NATS and a real `python -m app.worker` subprocess (not mocked, not simulated).

## Configuration

- Employees: 100,000
- Sites (org units): 500
- Shifts: 500 (1 per site, `requiredHeadcount: 1`, no skill requirement - deliberately trivial per-group solves, so this run measures decomposition/orchestration overhead at scale, not CP-SAT's own worst-case runtime on a hard model)

## Results

- Job outcome: **completed**
- Payload build time (client-side, Python dict construction): 0.20s
- `POST /v1/scheduling/jobs` HTTP round trip (enqueue only): 0.93s
- Time to first `solving` observed (enqueue -> worker claim): 1.82s
- Total wall time (enqueue -> terminal status): 17.14s
- Peak worker process RSS: 394 MB
- Decomposed: True (500 groups)
- Assignments persisted: 500
- Per-group CP-SAT solve time: avg 15.6ms, max 39ms across 500 groups

## Interpretation

The dominant cost at this scale was decomposition/orchestration overhead, not CP-SAT itself - each per-site sub-problem here is trivially easy (200 employees, 1 shift). `app/solver/decomposition.py`'s `_materialize_groups` filters the *entire* employee list once per group (`O(sites x employees)`); at 500 sites x 100k employees that is ~50M membership checks done in a single worker claim, single-threaded, before any solving starts. This is a real, honest scaling characteristic of the current implementation, not a hidden cost - flagged here rather than optimized away silently, per the module's own 'no vague sufficiency claims' rule. A future pass could index employees by `org_unit_id` once (`O(sites + employees)`) before materializing groups if this becomes a real bottleneck at even larger scale.

Sequential (not distributed) sub-problem execution within one worker's claim was a deliberate ADR-0061 decision (Decision 3) - true cross-worker parallelism for decomposed groups remains a documented future enhancement, not something this load test validates.

## Worker stderr (tail, for diagnosis if the run did not complete cleanly)

```
{"timestamp": "2026-08-07T11:42:27+0530", "level": "INFO", "logger": "agno.scheduling.worker", "message": "worker starting", "workerId": "AgnoShins-MacBook-Air.local:80673"}
{"timestamp": "2026-08-07T11:42:29+0530", "level": "INFO", "logger": "agno.scheduling.worker", "message": "job claimed", "jobId": "5dca82ac-918b-49f8-88e3-47cdbcd0905b", "workerId": "AgnoShins-MacBook-Air.local:80673"}
{"timestamp": "2026-08-07T11:42:44+0530", "level": "INFO", "logger": "agno.scheduling.worker", "message": "job reached terminal status", "jobId": "5dca82ac-918b-49f8-88e3-47cdbcd0905b", "tenantId": "3d7b4a52-0849-436a-b50f-15e2018043ce", "orgUnitId": "9f0f74f5-cae8-4791-bfe1-144880f1c996", "jobKind": "submit", "status": "completed", "solveDurationMs": 7819}
{"timestamp": "2026-08-07T11:42:44+0530", "level": "INFO", "logger": "agno.scheduling.worker", "message": "job execution finished", "jobId": "5dca82ac-918b-49f8-88e3-47cdbcd0905b", "workerId": "AgnoShins-MacBook-Air.local:80673"}
{"timestamp": "2026-08-07T11:42:45+0530", "level": "INFO", "logger": "agno.scheduling.worker", "message": "worker received shutdown signal - draining, no new jobs will be claimed", "workerId": "AgnoShins-MacBook-Air.local:80673"}
{"timestamp": "2026-08-07T11:42:45+0530", "level": "INFO", "logger": "agno.scheduling.worker", "message": "worker drained, shutting down", "workerId": "AgnoShins-MacBook-Air.local:80673"}
```
