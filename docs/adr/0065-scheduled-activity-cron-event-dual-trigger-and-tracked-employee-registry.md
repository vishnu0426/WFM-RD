# ADR-0065: `scheduled_activity` pre-load uses a cron-tick + NATS-event dual trigger over a TTL-bounded tracked-employee registry, with a coarse on-shift/null value

## Context
§2.2 rule 2 states the pre-load trigger precisely: "off `Schedule.published_at`
combined with the employee's actual shift start time." A schedule is
routinely published days before the shifts on it actually begin - so a pure
publish-time event (ADR-0064's `schedule.published.v1`) cannot, by itself,
be the moment `AgentLiveState.scheduled_activity` flips to reflect an
employee being on shift; that write has to land when the shift *starts*,
which is inherently a time-based condition, not a one-shot event.

At the same time, this service cannot poll scheduling-service for every
employee across a tenant's whole roster on every tick - most employees at
any given moment have no shift starting soon, and scheduling-service's read
endpoint (ADR-0064) has no bulk "everyone with an upcoming shift" query,
only a per-employee one.

## Decision
Two triggers, one hitting different halves of the problem:

1. **NATS events (`SchedulePublishedConsumerService`,
   `AssignmentChangedConsumerService`) determine *which* employees are
   worth checking.** On `schedule.published.v1`/`assignment.changed.v1`,
   every named employee gets a TTL-refreshed marker
   (`IntradayRedisService.trackEmployeeForScheduleSync`, key
   `tenant:{tenantId}:intraday:tracked-employee:{employeeId}`, plain `SET
   ... EX` - no `NX`, so a repeat event *extends* the TTL rather than
   failing). Default TTL 48h (`SCHEDULE_TRACKED_EMPLOYEE_TTL_SECONDS`) -
   generous enough to cover a shift published in advance plus its own
   duration. An employee with no relevant event in the TTL window
   self-prunes; there is no separate cleanup pass and no unbounded growth
   across a tenant's roster.
2. **`ShiftStartPreloadSchedulerService`'s `@Cron('* * * * *')` tick
   determines *when* to actually apply the change.** Every minute, it
   `SCAN`s the tracked-employee keys (bounded - only currently-tracked
   employees, never every employee platform-wide) and calls
   `ScheduledActivityService.refresh` for each. This mirrors the root
   app's `SkillDecaySchedulerService` shape exactly: coarse cadence
   (1 minute here vs. skill-decay's 15 - shift-start timing precision
   matters more), per-entity idempotent recheck, per-entity `try`/`catch`
   isolation so one employee's transient failure never blocks the tick.

Both consumers also call `ScheduledActivityService.refresh` once
immediately on receipt (not just marking the tracking key) - this covers a
schedule published for a shift already underway, or a mid-shift override,
without waiting up to a minute for the next tick.

**`ScheduledActivityService.refresh`** queries scheduling-service's
endpoint with `windowStart === windowEnd === now` - the endpoint's own
`shift_start < to AND shift_end > from` overlap filter, with a zero-width
window, is exactly "does any published assignment's half-open
`[shift_start, shift_end)` cover this instant." No arbitrary lookahead/
lookbehind padding is needed or used. `scheduled_activity` is set to a
fixed sentinel, `"on_shift"`, if any assignment is returned, `null`
otherwise - a coarse derived signal, not a rich per-queue/per-activity
value, because `ShiftAssignment` carries no activity-code field
(ADR-0064's consequences section already names this gap).

Redis writes for this and for `AgentStateChangedConsumerService`'s own
fields happen independently via `IntradayRedisService`'s Phase 2
partial-write support (`writeAgentLiveState` now takes
`Partial<AgentLiveStateFields>` - a key absent from the object is left
untouched, present-with-`null` clears via `HDEL`, present-with-a-value
sets via `HSET`). This is the correctness fix that makes the whole design
safe: without it, `ScheduledActivityService`'s writes (which only know
`scheduledActivity`) would null out `currentActivity`/`siteId`/`queueId`
every time it ran, and vice versa.

## Consequences
- `scheduled_activity` is `"on_shift"` or `null` only - not a per-queue/
  per-activity label. A richer signal would require scheduling-service to
  grow an activity-code data model it doesn't have today (ADR-0064); this
  ADR does not propose that.
- A boundary-instant edge case: a shift starting at exactly the millisecond
  a cron tick's `now` is captured could be missed by that specific tick (`shift_start
  < window_end` is a strict inequality) and picked up on the *next* tick
  instead - a sub-minute delay, accepted rather than engineering around,
  given §0.5's SLOs are framed in seconds/milliseconds for ingestion
  latency, not shift-start-preload precision.
- `ShiftStartPreloadSchedulerService` only ever refreshes *tracked*
  employees. An employee who somehow gets a published schedule without
  either NATS consumer ever seeing the event (e.g. this service was down
  for longer than the event's own redelivery guarantees hold, though
  JetStream durable consumers with `deliver_policy: All` don't lose
  messages across an outage the way this phrasing might suggest) would not
  be tracked and would not get pre-loaded until *some* event names them
  again. This is a narrower gap than it sounds - durable JetStream
  consumers persist their delivery cursor and redeliver on reconnect - but
  is worth stating plainly rather than assuming away.
- Single-instance ordering scope, mirroring ADR-0063: this phase's design
  assumes one running instance of `intraday-service`. Horizontal scaling
  (multiple replicas competing for the same durable consumer name) is not
  addressed here - ADR-0063 already named this as Phase 7 (load-test-driven
  partitioning) territory for `AgentStateChangedConsumerService`
  specifically; the two schedule-sync consumers have no ordering
  requirement of their own (tracking + refresh are both idempotent,
  last-write-wins operations), so multi-replica correctness for *them*
  is not blocked on that same future work, only on it being *convenient*
  once it exists.
