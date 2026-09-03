# Module 05 Phase 6 Design Doc — Intraday/Real-Time Management: Reallocation Recommendation + Approval Flow

**Status:** Approved for implementation
**Owner:** Intraday pod (Module 05)
**Scope:** `ReallocationAction` (§2.1), the recommendation engine consuming
`queue.metrics_updated` (§5), `approveReallocation`/`pendingReallocations`
(GraphQL) and `POST /v1/intraday/reallocations/:id/approve` (REST, §4.2),
the `reallocationSuggested` subscription, and the feature-flagged
auto-execute path (§8, off by default).

## Problem

§8 phase 6 asks for `ReallocationAction` with mandatory `ai_rationale`
and a feature-flagged auto-execute path, but unlike Phase 5's alert
pipeline, §5 gives no dedicated design section for reallocation logic —
it only names the reallocation recommendation engine as one of three
consumers of `queue.metrics_updated`. This phase had to design the actual
recommendation heuristic from scratch. Four real gaps shaped it:

1. **`ReallocationAction.affected_employee_ids` needs real employee IDs,
   and nothing in this service could answer "which employees are in queue
   X."** `AgentLiveState` has a forward `queue_id` per employee but no
   reverse index existed. Fabricating IDs would violate this service's
   established honesty convention.
2. **`ai_rationale`'s shape needed a confirmed convention.** Module 01's
   `AuditLog.aiRationale` is `jsonb`, a deterministic, real-metrics-citing
   object — never an actual LLM call anywhere in this repo.
3. **The auto-execute feature flag needed a home** without reaching into
   the root app's `org.feature_flags` system (the same cross-module
   coupling ADR-0069 already avoided).
4. **§4 exposes no separate "execute" endpoint** — only
   `approveReallocation`/`POST .../approve` — so what "approved" vs.
   "executed" actually means operationally had to be decided.

A fifth, smaller gap: §4.1 lists `reallocationSuggested(orgUnitId)` and
`approveReallocation`, but no query to list pending suggestions — without
one, `approveReallocation` has no way to discover a suggestion's id in
practice. Same class of necessary addition as Phase 5's own `activeAlerts`
query.

## Decision

See ADR-0070 for the full reasoning behind the four load-bearing
decisions. Summary of what shipped:

- **Queue-membership reverse index**: `queueAgentsKey` (a Redis SET),
  maintained by `AgentStateChangedConsumerService` — reads the employee's
  prior `AgentLiveState` before its existing write to get the previous
  `queueId`, then updates the reverse index via `updateQueueMembership`.
  Both the read and the update are best-effort (caught, logged, never
  thrown) so a Redis blip on this auxiliary concern can never block the
  consumer's actual job (the state write). `trackedQueueKey` gives the
  recommendation engine a bounded, self-pruning "which queues are active
  for this tenant" registry, refreshed on every `queue.metrics_updated`.
- **`ReallocationRecommendationService.evaluateQueueMetrics`**, called
  from `QueueMetricsUpdatedConsumerService` right after the alert-engine
  call. On a breach, searches the tenant's tracked queues for the
  largest-surplus donor (`serviceLevelCurrent - serviceLevelTarget >
  0.10` and `agentsAvailable > 0` — a concrete, documented threshold),
  takes one real employee ID from that donor's tracked membership (never
  fabricated — no donor or no tracked member means no suggestion at
  all), and inserts a `suggested` row with a deterministic `ai_rationale`
  citing the actual trigger metrics. A lightweight repeat-guard (not
  Alert's full §5a dedup/suppression pipeline, which is scoped to `Alert`
  specifically) skips creating a new row while one is already
  `suggested`/`approved` for the same `(from_queue, to_queue)` pair.
  Publishes to `agno.intraday.reallocation.suggested.v1` (§4.3's
  already-reserved, previously-unused subject) and the in-process
  `reallocationSuggested` PubSub trigger.
- **Feature-flagged auto-execute**: `INTRADAY_REALLOCATION_AUTO_EXECUTE_ENABLED`
  (env var via `ConfigService`, default `false`). When enabled, a newly
  `suggested` row is immediately applied and transitioned to
  `auto_executed` in the same call, no `approveReallocation` needed.
- **`ReallocationExecutionService.applyReallocation`**: the one real,
  honest execution side effect — moves each affected employee's
  `AgentLiveState.queue_id` in Redis (which also keeps the reverse index
  correct). No integration with a real ACD/telephony call-routing system
  exists anywhere in this repo — the same class of honest gap as Phase
  5's escalation having no real notification fan-out. Shared by both the
  auto-execute branch and manual approval.
- **`ReallocationApprovalService.approve`**: `suggested` → `approved` →
  `executed`, all in one call — §4 exposes no separate execute step, so
  approving is necessarily what triggers it. Throws
  `ReallocationNotFoundError` (404) or `ReallocationNotSuggestedError`
  (409, a real state conflict) as appropriate.
- **`ReallocationQueryService.listPendingReallocations`** — the
  necessary `pendingReallocations` query addition.
- REST (`POST /v1/intraday/reallocations/:id/approve`) shares
  `ReallocationApprovalService` with the GraphQL mutation — one action
  path, two transports, matching `LiveStateRestController`'s own
  precedent.
- Own-copy `JsonScalar` (`src/graphql/json.scalar.ts`), copied from root
  app's `src/common/graphql/json.scalar.ts`, for `aiRationale: JSON` —
  avoids a `graphql-type-json` dependency for one field.

## Blast radius

New `src/reallocation/` directory (7 files), one new migration (additive
schema only), one new GraphQL scalar file. `redis/keys.ts`/
`redis/redis.service.ts` gain four new methods (additive).
`AgentStateChangedConsumerService.handlePayload` gains one Redis read
before its existing write plus a best-effort membership update after it.
`QueueMetricsUpdatedConsumerService` gains two calls (tracked-queue
refresh + recommendation engine) after its existing alert-engine call.
`ConsumersModule`/`IntradayGraphQLModule` each gain one new import.
`DomainErrorFilter` gains two status-code entries. No change to Phases
1-5's own logic otherwise. No `docker-compose.yml` change, no new npm
dependency.

## Rollback plan

Revert the migration (`DROP TABLE intraday.reallocation_action`), delete
`src/reallocation/` and `src/graphql/json.scalar.ts`, revert the four
Redis method additions and the two consumer call-site additions, remove
the two module imports and the two `STATUS_BY_CODE` entries. Nothing
outside this phase depends on any of it.

## Explicit assumptions

1. The queue-membership reverse index adds one Redis read to
   `AgentStateChangedConsumerService`'s hot path — a deliberate,
   documented cost, not yet measured against a load test (Phase 7).
2. `ai_rationale` is a deterministic jsonb object citing real trigger
   metrics, matching Module 01's own convention — never a real LLM/ML
   call.
3. The auto-execute flag is a plain env var via `ConfigService`, not
   integrated with the root app's `org.feature_flags` system.
4. Only one employee is moved per suggestion — a conservative, minimal
   heuristic; moving a variable/larger number is out of scope.
5. "Approve" causes immediate execution in the same call — no separate
   execute step exists anywhere in §4.
6. `rejectReallocation` has no mutation/endpoint in §4 — `status:
   'rejected'` is schema-modeled but unreachable this phase.
7. Execution's only real side effect is updating `AgentLiveState.queueId`
   in Redis — no integration with a real ACD/telephony call-routing
   system exists anywhere in this repo.
8. `pendingReallocations(tenantId)` is a necessary addition beyond §4.1's
   literal query list.
9. `reallocationSuggested`'s `orgUnitId` argument is accepted but
   unused — `ReallocationAction` has no `org_unit_id` field in §2.1 at
   all, an even more literal absence than `Alert`'s always-`null` one.

## Out of scope for this phase

- Real ACD/telephony call-routing integration (assumption 7).
- `rejectReallocation` (assumption 6).
- Moving more than one employee per suggestion (assumption 4).
- Root `org.feature_flags` integration for the auto-execute gate (assumption 3).
- The Phase 7 load test measuring the new consumer read's actual cost (assumption 1).
- A full reallocation audit/history query beyond `pendingReallocations`'s suggested-only scope.
- `graphql-ws` connection-level tenant authentication — same gap ADR-0068 already flagged, not re-litigated here.
- Multi-region — Phase 8.

## Verification

- `npm run typecheck && npm run build && npm run lint && npm test` — all
  clean; 168 tests across 39 suites (9 new spec files this phase:
  `ReallocationRecommendationService`'s donor-selection heuristic,
  repeat-guard, and auto-execute branch; `ReallocationExecutionService`;
  `ReallocationApprovalService`'s not-found/wrong-state/happy-path
  branches; `ReallocationQueryService`; the new resolver and REST
  controller; `IntradayRedisService`'s new reverse-index/tracked-queue
  methods; `AgentStateChangedConsumerService`'s new read-before-write
  behavior including its best-effort failure handling; plus additive
  coverage on `QueueMetricsUpdatedConsumerService`'s existing spec for
  its new `ReallocationRecommendationService` call).
- Migration run against real local Postgres; RLS, both indexes, all
  three CHECK constraints (including `ai_rationale`'s conditional
  requirement), and grants (`agno_intraday_app`: `SELECT, INSERT,
  UPDATE`, no `DELETE`) confirmed via `psql`.
- End-to-end against real Redis/NATS/Postgres, booted service:
  hand-published an `agent.state_changed` message to populate real queue
  membership, then a surplus `queue.metrics_updated` for the donor and a
  breaching one for the target — confirmed a real `suggested` row with a
  real `affected_employee_ids` entry and a real, metrics-citing
  `ai_rationale`, published to a live `reallocationSuggested` `graphql-ws`
  subscription. Published a second breach tick — confirmed the
  repeat-guard (still exactly one row). Ran `approveReallocation` via
  GraphQL — confirmed `status: 'executed'` and the employee's
  `AgentLiveState.queueId` and reverse-index membership actually moved in
  Redis. Confirmed `REALLOCATION_NOT_FOUND` (unknown id) and
  `REALLOCATION_NOT_SUGGESTED` (re-approving an already-executed row) both
  surface correctly, and `pendingReallocations` correctly excludes the
  now-executed row. Restarted the service with
  `INTRADAY_REALLOCATION_AUTO_EXECUTE_ENABLED=true`, repeated the
  donor/target scenario with a fresh queue/employee pair — confirmed the
  row went straight to `auto_executed` with `executed_at` set and the
  employee's queue moved, with no `approveReallocation` call ever made.
