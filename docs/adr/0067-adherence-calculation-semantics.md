# ADR-0067: adherence-calculation semantics — coarse on-shift comparison, self-referential `from_activity`, deterministic `deviation_seconds`

## Context
The module prompt names `deviation_seconds` as an `AdherenceEvent` field
and names "the adherence calculator" as a NATS consumer responsibility
(§4.3) but never defines the comparison it's actually computing. Two facts
already established elsewhere in this module constrain what's honestly
derivable:

1. `scheduled_activity` (§2.2 rule 2, Phase 2, ADR-0064/0065) is coarse —
   `"on_shift"` or `null` — because `ShiftAssignment` (scheduling-service's
   schema) carries no activity-code field anywhere in this platform.
   There is no richer taxonomy (break vs. lunch vs. working a specific
   queue) to compare against.
2. `AgentStateChangedConsumerService` (Phase 2) and a new adherence
   calculator both need to react to the *same* `agent.state_changed`
   event, independently (§4.3's own architecture), which raises a real
   correctness question: where does "the previous activity" (`from_activity`)
   come from, if two independent consumers race on the same message?

## Decision
**Adherence is binary and coarse**: adherent means `scheduled_activity ===
"on_shift"` — any `current_activity` value is treated as consistent with
being on shift, since there's no taxonomy to be stricter with. Anything
else (`null`, or in principle any other future value) is non-adherent.
`isAdherent()` (`src/adherence/adherence-rule.ts`) is the single place
this comparison lives.

**`from_activity` is read from this employee's own most recent
`AdherenceEvent` row in Postgres** (`ORDER BY timestamp DESC LIMIT 1`),
never from Redis's current `AgentLiveState.currentActivity`. This is the
correctness fix for the two-independent-consumers problem: by the time
`AdherenceCalculatorConsumerService` runs, `AgentStateChangedConsumerService`
may have *already* overwritten Redis with this same event's new value,
which would make `from`/`to` indistinguishable if read from there. The
self-referential Postgres lookup is immune to that race by construction —
it reads what *this consumer itself* wrote last time, never a value the
other consumer might have just changed. `scheduled_activity`, by contrast,
*is* read from Redis (`IntradayRedisService.readAgentLiveState`) — safely,
because that field is written only by `ScheduledActivityService`, an
entirely separate pipeline neither of these two consumers ever touches.

**`deviation_seconds` is the duration of the segment that just ended.**
Concretely: look at the previous `AdherenceEvent` row's own stored
`scheduled_activity` (not a fresh Redis read — the historical value as of
that prior transition). If that segment was adherent, `deviation_seconds
= 0`. If it was not, `deviation_seconds` = `this_event.timestamp -
previous_event.timestamp`, in seconds, floored at zero (defends against
an out-of-order/clock-skew timestamp producing a negative value). A
first-ever event for an employee (`previousEvent === null`) also yields
`0` — there is no prior segment to have been in deviation for, which
doubles as the "genuinely unknown schedule, benefit of the doubt" outcome
without needing a separate flag to express it.

This is fully deterministic — built only from stored timestamps, never
"processing time now" — so a NATS redelivery (this consumer's `nak()` path
on a transient Postgres failure) recomputes the identical value on retry,
not a different one each time.

## Consequences
- This is a real, stated interpretation of an underspecified field, not
  the only possible one. A future phase with a richer activity-code
  taxonomy (requires scheduling-service to grow one — ADR-0064's own
  consequences section already flags this as a real, unbuilt follow-up)
  could redefine `deviation_seconds` more precisely (e.g. per-activity
  scheduled-vs-actual comparison); this ADR's definition is the honest
  ceiling of what today's coarse `on_shift`/`null` signal supports, not a
  permanent design choice.
- `event_type` is always the literal `'activity_changed'` this phase — the
  column exists in the schema for future producers (e.g. a
  `schedule_changed` event type distinct from an activity transition), not
  populated by anything else yet.
- A Postgres write failure in `AdherenceCalculatorConsumerService.handlePayload`
  `nak()`s the NATS message (the shared `DurableJetStreamConsumer` base
  class's behavior) rather than silently dropping the compliance record —
  `AdherenceEvent` is the durable historical record; losing one because
  Postgres was briefly unavailable is exactly the "looks fine but isn't"
  failure mode this module's §6.1 spirit rules out everywhere else too.
  Redis/live-dashboard functionality (`AgentStateChangedConsumerService`)
  is entirely unaffected by a Postgres outage - this consumer's own
  backlog growing (visible as NATS consumer lag) is the only symptom.
