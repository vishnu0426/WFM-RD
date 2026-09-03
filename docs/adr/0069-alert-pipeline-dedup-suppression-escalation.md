# ADR-0069: alert pipeline — self-contained alert_policy table, actorId widening, and escalation as severity-bump-only

## Context
§5a flags the alert pipeline as an open product-design gap in the source
spec and asks for the full stage - dedup ("repeat triggers... collapse
into one Alert, not N"), suppression (tenant-configurable rules, e.g. "an
expected lunch-hour dip"), and escalation ("an unacknowledged alert past a
defined time threshold escalates... define the escalation policy as
tenant-configurable data") - not just a raw threshold-breach-to-delivery
path. Four sub-decisions had no literal answer in §2.1/§5a:

1. **§2.1's `Alert` schema has no field for "is this still the same
   ongoing issue."** Collapsing repeat triggers needs some mutable
   timestamp to distinguish a continuation from a fresh occurrence.
2. **Where does the dedup/suppression/escalation policy - and §5a's
   suppression-rule example - actually live?** Reaching into Module 01's
   generic `Policy` system would be real cross-module scope creep this
   phase doesn't take on, the same boundary Module 04 already draws
   around Module 01/02's data.
3. **`acknowledgeAlert` needs to know who acknowledged.** Phase 4's
   `TenantContextService` only ever carried `tenantId`.
4. **§5a's "wider notification scope" on escalation has no real delivery
   mechanism in this module.** Actual fan-out is Module 01's
   `NotificationService`, out of reach without new cross-module work.

## Decision
**Schema extension**: `intraday.alert` (new migration, same `intraday`
schema/RLS/grants convention as Phase 3) adds `last_triggered_at`
(updated on every duplicate trigger within the dedup window),
`escalated_at`, `acknowledged_by`/`acknowledged_at`, and `resolved_at`
beyond §2.1's literal field list - necessary for the pipeline to function
at all, the same class of addition Phase 3's rollup tables already needed
beyond their own literal schema sketch.

**Policy-as-data, not Module 01 integration**: a small, self-contained
`intraday.alert_policy` table (one row per tenant: `dedup_window_minutes`
default 5, `suppression_ack_window_minutes` default 15,
`escalation_threshold_minutes` default 15, `suppression_rules jsonb` - an
array of `{alertType, queueId | null, startHourUtc, endHourUtc}`, the
minimal shape that expresses §5a's own lunch-hour-dip example). No row for
a tenant is a valid, expected state - `AlertPolicyService` applies
`DEFAULT_ALERT_POLICY` in application code, not a second code path.

**Pipeline** (`AlertPipelineService`, sitting between the raw NATS
consumer's detector and the `alertRaised` publish point, per §5a point 4's
own explicit placement ask): dedup collapses a repeat trigger for the same
`(tenant_id, queue_id, alert_type)` within the window into the existing
row's `last_triggered_at`, no new row, no publish. Outside the window,
suppression checks (a) the tenant's `suppression_rules` for a time-window
match and (b) whether the most recent alert in the same `dedup_group_id`
was acknowledged within the ack window - either → insert with
`status: 'suppressed'`, still queryable (§2.2 rule 4: suppressed is a
real, auditable outcome, not a silent drop), no publish. Otherwise →
insert `status: 'open'`, publish. `AlertEscalationSchedulerService`
(`@Cron('*/5 * * * *')`, matching Phase 3's scheduler shape exactly, using
the same `MIGRATOR_PG_POOL` cross-tenant pattern ADR-0066 established)
scans open `warning` alerts older than the tenant's escalation threshold,
bumps them to `critical`, sets `escalated_at`, re-publishes.

**`TenantContextService` widened, not replaced**: `TenantContextStore`
gains an optional `actorId`, bound from a new `X-Actor-Id` header (same
header-trust placeholder convention as `X-Tenant-Id`, ADR-0068). A request
with a valid tenant but no actor still binds fine; only
`acknowledgeAlert` calls `requireActorId()` and fails closed at that point
of use, the identical posture `requireTenantId()` already has.

**Escalation's real scope**: implemented as exactly what's achievable in
this module - a severity bump plus an `alertRaised` re-publish. No
notification delivery is fabricated.

## Consequences
- `acknowledgeAlert` requires a client to send `X-Actor-Id`; a request
  that only sends `X-Tenant-Id` gets `ACTOR_CONTEXT_MISSING` (400). No
  UI/client in this repo sets the header yet - out of scope for this
  phase, same as every other header-trust gap already flagged
  (ADR-0068).
- The suppression/escalation windows and rules are tenant-configurable
  only via direct writes to `intraday.alert_policy` - no admin
  mutation/UI exists to manage them this phase. A tenant that never gets a
  row simply runs on `DEFAULT_ALERT_POLICY` indefinitely.
- Escalation's "wider notification scope" is not real fan-out. A
  `critical`-severity, unacknowledged, escalated alert produces no email/
  Slack/SMS - only a GraphQL subscription push to whoever happens to be
  connected. Wiring this to Module 01's `NotificationService` is real,
  scoped follow-up work, not done here.
- Only one detector exists this phase (`service_level_breach`, from
  `QueueMetricsUpdatedConsumerService`). Any `agent.state_changed`-derived
  alert type (e.g. an adherence-deviation alert) needs its own detector
  wired the same way `AlertEngineService.evaluateQueueMetrics` is, not
  built here - §5a's own example is queue-focused, and a second detector
  without a second concrete signal to justify it would be speculative.
