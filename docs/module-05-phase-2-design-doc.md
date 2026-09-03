# Module 05 Phase 2 Design Doc — Intraday/Real-Time Management: State Propagation Pipeline

**Status:** Approved for implementation
**Owner:** Intraday pod (Module 05) — Principal Performance Engineer (Redis/NATS
write/consume-path design, per §0), coordinating with the Scheduling pod
(Module 04) for the cross-module read/event surface this phase depends on.
**Scope:** §8's Phase 2 bullet in full — NATS consumers writing Redis state,
the per-employee ordering guarantee (ADR-0063 made real by an actual
consumer), and `scheduled_activity` pre-load from Module 04 at shift start
including mid-shift schedule-change handling (§2.2 rule 2). Touches two
services: an additive extension to `scheduling-service` (ADR-0064) and
`intraday-service`'s own consumer/schedule-sync pipeline (ADR-0065). No
Postgres/`AdherenceEvent` in `intraday-service` still (Phase 3). No
GraphQL/REST live-read API surface yet (Phase 4) — this phase only makes
Redis *correct*, nothing reads it back through this service yet.

## Problem

Phase 1 shipped a Redis client, a webhook ingestion endpoint, and a NATS
publish skeleton — but nothing consumed `agno.intraday.agent.state_changed.v1`,
and `AgentLiveState.scheduled_activity` had never been written by anything.
Phase 2's job is to close both gaps for real, which turned out to require
more than intraday-service alone:

1. **Module 04 had no way to answer "what is this employee scheduled to
   do."** Auditing `scheduling-service` end to end (every `api/v1/*.py`
   route, `schedule_service.py`, `nats_publisher.py`) found every existing
   endpoint scoped by `job_id`/`schedule_id`, never by employee, and found
   that `publish_schedule`/`override_assignment` emitted no event at all —
   only a solver-completion event (`agno.scheduling.job.completed.v1`)
   existed. This is a genuine gap in the original cross-module design (Module
   04's 8 phases were scoped before Module 05 existed), not a bug to route
   around — ADR-0064 extends scheduling-service additively to close it: a
   new employee-scoped read endpoint, and two new publish-time events.
2. **A schedule published in advance must not pre-load `scheduled_activity`
   early.** §2.2 rule 2 is explicit that the trigger is `published_at`
   *combined with* the employee's actual shift-start time — the write has
   to land at shift start, which is a time-based condition a publish-time
   event alone cannot express. ADR-0065 resolves this with a dual
   trigger: NATS events determine *which* employees are worth watching
   (a bounded, TTL-pruned tracked-employee registry), a `@Cron` tick
   (mirroring the root app's `SkillDecaySchedulerService` shape) determines
   *when* to actually apply the change.
3. **Two independent writers now touch the same Redis hash.** The
   agent-state-changed consumer knows `currentActivity`/`activityStartedAt`/
   `siteId`/`queueId`; the schedule-sync path knows only
   `scheduledActivity`. Phase 1's `writeAgentLiveState`/`writeQueueLiveState`
   required every field, which would have made one writer silently null out
   the other's fields on every call. Fixed by widening both methods to
   `Partial<...Fields>` — a key absent from the object is left untouched, a
   key present with `null` clears it, a key present with a value sets it.
   `writeHash`'s existing implementation already had the right behavior
   once the type allowed a key to be absent at all; this was a
   type-signature fix, not new write logic.
4. **`ShiftAssignment` has no activity-code field.** Only `shift_start`/
   `shift_end`/`skill_id`. `scheduled_activity` is therefore necessarily a
   coarse `"on_shift"`/`null` signal (ADR-0065), not a rich per-queue value
   — documented as an explicit assumption rather than silently invented.

## Decision

See ADR-0064 (scheduling-service's new endpoint + events) and ADR-0065
(the cron+event dual trigger, the tracked-employee registry, the
partial-write fix, the coarse-activity interpretation) for the full
reasoning. Summary of what shipped:

**`scheduling-service`**: `GET
/v1/scheduling/employees/{employeeId}/shift-assignments?from=&to=`
(published-only, overlap-filtered); `agno.scheduling.schedule.published.v1`
and `agno.scheduling.assignment.changed.v1`, published from
`publish_schedule`/`override_assignment` respectively, before the
transaction commits (matching `job_service.py`'s own existing precedent).
Both new subjects live under the existing `agno.scheduling.>` wildcard —
no stream config change needed. `reoptimize_schedule` does not yet publish
`assignment.changed.v1` (ADR-0064's consequences section) — a real,
flagged gap, not silently dropped.

**`intraday-service`**:
- `AgentStateChangedConsumerService` — a durable, strictly-sequential
  JetStream consumer on `agno.intraday.agent.state_changed.v1.>`, writing
  `currentActivity`/`activityStartedAt`/`siteId`/`queueId` only. Sequential
  processing is what trivially satisfies ADR-0063's per-employee ordering
  guarantee for a single running instance.
- `SchedulePublishedConsumerService`/`AssignmentChangedConsumerService` —
  durable consumers on scheduling-service's *own* stream (`AGNO_SCHEDULING`,
  hardcoded — a documented cross-service naming coupling), tracking
  affected employees and triggering an immediate refresh.
- `ScheduleServiceClient` — `fetch`-based, calls the new endpoint,
  `X-Tenant-Id` header (matching scheduling-service's own current
  header-trust convention — no cross-service JWT exists in this platform
  yet).
- `ScheduledActivityService.refresh` — zero-width `[now, now)` query,
  `"on_shift"` if anything comes back, `null` otherwise.
- `ShiftStartPreloadSchedulerService` — `@Cron('* * * * *')`, scans the
  bounded tracked-employee set, refreshes each with per-entity isolation.
- `DurableJetStreamConsumer<TPayload>` — a shared abstract base class
  factoring out the identical init/pull-loop/poison-message/nak-on-failure
  mechanics all three consumers share; each subclass supplies only its
  `binding()` and `handlePayload()`. `bindDurableConsumer` factors out the
  shared idempotent consumer-provisioning boilerplate underneath that.

## Blast radius

- `scheduling-service`: one new router file, one new schema, one new pure
  service function, two existing service functions
  (`publish_schedule`/`override_assignment`) gain one new required
  parameter and one new call each — both existing route handlers were the
  only callers, so this is mechanical. No migration, no schema change, no
  behavior change to any other existing endpoint.
- `intraday-service`: new consumer/schedule directories, one new
  dependency (`@nestjs/schedule`), a type-signature widening on two Phase
  1 Redis write methods (not yet called by real traffic before this phase,
  so no behavior regression for anything running today). No change to the
  Phase 1 ingestion path's own logic.
- No `docker-compose.yml` change. No new Postgres schema anywhere.

## Rollback plan

`scheduling-service`: revert the new router/schema/publisher functions and
the two parameter additions. `intraday-service`: delete the new
consumer/schedule directories, revert the Redis service type-signature
change, remove `ConsumersModule`/`ScheduledActivityModule` from
`app.module.ts`. Nothing outside these two services depends on any of this
yet.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`scheduled_activity` is `"on_shift"`/`null`, not a rich activity
   code** — see ADR-0065. Revisiting this requires scheduling-service to
   grow an activity-code data model, out of scope here.
2. **Single-instance ordering scope.** `AgentStateChangedConsumerService`'s
   strictly-sequential processing guarantees per-employee ordering for one
   running `intraday-service` instance. Horizontal scaling across replicas
   while preserving that guarantee is explicit Phase 7 territory
   (ADR-0063's own forward reference), not solved here.
3. **`reoptimize_schedule` doesn't publish `assignment.changed.v1`.**
   Flagged in ADR-0064 — closing this means wiring `app/worker.py`'s
   reoptimize-completion path into `nats_publisher`, a real follow-up, not
   done in this phase.
4. **Cross-service tenant identity is still header-trust only.**
   `ScheduleServiceClient` sends `X-Tenant-Id` because that's what
   scheduling-service's `TenantContextMiddleware` currently accepts — no
   cross-service JWT/mTLS exists anywhere in this platform yet. Not a new
   gap this phase introduces, just one it now has a second caller of.
5. **The tracked-employee TTL (48h default) is a judgment call**, not
   derived from any stated SLO — generous enough to cover a schedule
   published in advance plus a typical shift's duration, refreshed on every
   relevant event so an actively-scheduled employee never ages out
   mid-window.

## Out of scope for this phase (do not build yet)

- `AdherenceEvent`, Postgres schema/role/RLS, partitioning, rollups — Phase 3.
- GraphQL queries/mutations/subscriptions, REST snapshot fallback — nothing
  reads `AgentLiveState`/`QueueLiveState` back through this service yet —
  Phase 4.
- Alert dedup/suppression/escalation pipeline — Phase 5.
- `ReallocationAction`, `ai_rationale`, feature-flagged auto-execute — Phase 6.
- The full §6.1 `dataFreshness` degradation contract on a live-read API,
  the 100k+-agent release-gate load test, horizontal-scaling-safe
  per-employee partitioning across replicas — Phase 7.
- Multi-region topology — Phase 8.
- `reoptimize_schedule` publishing `assignment.changed.v1` (see assumption 3).
- A durable per-tenant webhook secret store (Phase 1's still-open gap,
  unrelated to this phase's scope).
