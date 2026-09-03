# ADR-0070: reallocation — queue-membership reverse index, ai_rationale convention, self-contained auto-execute flag, and approve-causes-execution

## Context
§8 phase 6 asks for `ReallocationAction` with mandatory `ai_rationale`
(§2.2 rule 3) and a feature-flagged auto-execute path, off by default.
Unlike Phase 5's alert pipeline, §5 gives no dedicated design section for
reallocation logic — it only names the reallocation recommendation engine
as one of three consumers of `queue.metrics_updated`, alongside the API
surface in §4. This phase had to design the actual recommendation
heuristic from scratch, and four sub-decisions had no existing precedent
to copy:

1. **`ReallocationAction.affected_employee_ids` needs real employee IDs,
   and nothing in this service could answer "which employees are in queue
   X."** `AgentLiveState` has a forward `queue_id` per employee, but no
   reverse index existed. Fabricating IDs would violate this service's
   established honesty convention (`org_unit_id` staying `null` rather
   than guessed, Phase 5's escalation having no fake notification
   fan-out).
2. **`ai_rationale`'s shape needed a real, confirmed convention to
   match.** Module 01's `AuditLog.aiRationale`
   (`src/modules/audit/entities/audit-log.entity.ts:51-52`) is `jsonb`, a
   free-form `Record<string, unknown>`, populated with a deterministic,
   real-metrics-citing object — never an actual LLM call anywhere in this
   repo (confirmed via seed data and scheduling-service's `relaxation.py`
   deterministic explanation builder).
3. **The auto-execute feature flag needed a home.** This repo has a real,
   structured, DB-backed flag system (`org.feature_flags`,
   `FeatureFlagsService.isEnabled`) — but it lives in the root app's own
   schema, and reaching into it would be exactly the cross-module
   coupling ADR-0069 already avoided for `alert_policy`.
4. **§4 exposes no separate "execute" endpoint anywhere** — only
   `approveReallocation`/`POST .../approve`. What "approved" vs.
   "executed" as distinct enum values actually means operationally had to
   be decided.

## Decision

**Reverse index**: `queueAgentsKey(tenantId, queueId)`, a Redis SET,
maintained by `AgentStateChangedConsumerService` — reads the employee's
prior `AgentLiveState` (one extra `HGETALL`) before its existing write to
get the previous `queueId`, then calls `updateQueueMembership` (pipelined
`SREM`/`SADD`). Both the read and the membership update are best-effort
(caught, logged, never thrown) — this consumer's actual job (Phase 2's
`AgentLiveState` write) must never become fragile to a transient Redis
blip on this auxiliary concern. `trackedQueueKey`, a TTL'd marker mirroring
`trackedEmployeeKey`, gives `ReallocationRecommendationService` a bounded,
self-pruning "which queues are currently active for this tenant" registry
without a tenant-wide scan.

**`ai_rationale`**: a deterministic `jsonb` object citing the actual
trigger metrics (`{triggerMetric, toQueue: {...}, fromQueue: {...},
heuristic: 'largest_service_level_surplus_donor', surplusThreshold}`) —
matching Module 01's own convention exactly. Never a real LLM/ML call,
consistent with every other "AI-labeled" field in this repo.

**Auto-execute flag**: a plain `INTRADAY_REALLOCATION_AUTO_EXECUTE_ENABLED`
env var read via `ConfigService`, default/absent = `false`. Not
integrated with `org.feature_flags` — same cross-module-avoidance
reasoning as ADR-0069's `alert_policy`.

**Approve causes execution**: `suggested` → `approved` → `executed`, all
within `ReallocationApprovalService.approve`'s one call. No separate
execute step exists anywhere in §4, so approving is necessarily what
triggers it — not left ambiguous. The one real, honest execution side
effect (`ReallocationExecutionService.applyReallocation`) updates
`AgentLiveState.queue_id` in Redis for each affected employee; it does
**not** integrate with any real ACD/telephony call-routing system, the
same class of honest gap as Phase 5's escalation having no real
notification fan-out.

## Consequences
- The queue-membership reverse index adds one Redis read to
  `AgentStateChangedConsumerService`'s hot path — a deliberate, documented
  cost, not yet measured against a load test (Phase 7's job). Because the
  read and the membership update are both best-effort, a Redis blip during
  exactly that read can leave the reverse index stale (an employee
  remaining listed under a queue they've since left) until their next
  successful state change — a bounded, documented imprecision, not a
  correctness bug in the core state write.
- A reallocation suggestion is only ever created when both a qualifying
  donor queue *and* at least one tracked member of that donor exist — a
  breaching queue with no discoverable donor, or a metrics-overstaffed
  donor with no tracked agent identity yet, produces no suggestion at
  all rather than a suggestion with fabricated or missing data.
- `rejectReallocation` has no mutation/endpoint anywhere in §4 —
  `status: 'rejected'` is schema-modeled but unreachable this phase, the
  same explicit-gap honesty as Phase 5's `Alert.status = 'resolved'`
  being reachable only via auto-resolution.
- `pendingReallocations(tenantId)` is a necessary addition beyond §4.1's
  literal query list — without it, `approveReallocation` has no way to
  discover a pending suggestion's id in practice, the same necessity
  Phase 5's `activeAlerts` already established for `acknowledgeAlert`.
