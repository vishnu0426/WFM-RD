# Module 05 Phase 5 Design Doc — Intraday/Real-Time Management: Alert Pipeline

**Status:** Approved for implementation
**Owner:** Intraday pod (Module 05)
**Scope:** §5a's full dedup/suppression/escalation alert pipeline, the
`service_level_breach` detector fed by Phase 4's
`QueueMetricsUpdatedConsumerService`, and §4.1's previously-deferred
`activeAlerts` query / `acknowledgeAlert` mutation / `alertRaised`
subscription (Phase 4's design doc explicitly named these as blocked on no
`Alert` entity existing yet). `reallocationSuggested`/
`approveReallocation` are not built — Phase 6.

## Problem

§5a flags the alert pipeline as an open product-design gap in the source
spec, not a fully-specified feature: it asks for the full stage (dedup,
suppression, escalation), not just a raw threshold-breach-to-delivery
path, but leaves several concrete decisions unmade. Four real gaps shaped
this phase:

1. **§2.1's `Alert` schema has no field for "is this still the same
   ongoing issue."** Collapsing repeat triggers into one row (§5a point 1)
   needs some mutable timestamp to distinguish a continuation from a fresh
   occurrence — nothing in the literal schema sketch provides one.
2. **Where does the dedup/suppression/escalation policy — and §5a's own
   suppression-rule example ("an expected lunch-hour dip, don't alert") —
   actually live?** No existing table in this service or a natural home in
   Module 01's generic `Policy` system without real cross-module
   integration work.
3. **`acknowledgeAlert` needs to know who acknowledged.** Phase 4's
   `TenantContextService` only ever carried `tenantId` — nothing before
   this phase needed an actor identity at all.
4. **§5a's "wider notification scope" on escalation has no real delivery
   mechanism anywhere in this module.** Actual notification fan-out is
   Module 01's `NotificationService`, out of reach without new
   cross-module work this phase doesn't take on.

See ADR-0069 for the full reasoning behind all four decisions.

## Decision

Summary of what shipped (ADR-0069 has the complete rationale):

- **Schema** (`1700000300000-AlertSchema.ts`, same `intraday` schema/RLS/
  grants convention as Phase 3): `intraday.alert` extends §2.1's literal
  field list with `last_triggered_at`, `escalated_at`,
  `acknowledged_by`/`acknowledged_at`, `resolved_at`. `intraday.alert_policy`
  — one row per tenant, sane defaults (`dedup_window_minutes: 5`,
  `suppression_ack_window_minutes: 15`, `escalation_threshold_minutes: 15`,
  `suppression_rules: []`) applied in application code when no row exists,
  not integrated with Module 01's `Policy` system.
- **Detection**: `AlertEngineService.evaluateQueueMetrics`, called from
  `QueueMetricsUpdatedConsumerService` right after its existing Redis
  write — §5's own architecture example ("a queue breaching its
  service-level target"). A breach raises; a cleared breach auto-resolves
  (no `resolveAlert` mutation exists in §4.1, so this is the only path to
  `status: 'resolved'`). Severity is `critical` when the deficit ratio
  exceeds 20%, `warning` otherwise — a simple, defensible threshold.
- **Pipeline** (`AlertPipelineService`, kept structurally separate from
  the detector per §5a point 4's own explicit ask): dedup collapses a
  repeat trigger for the same `(tenant_id, queue_id, alert_type)` within
  the policy's window into the existing row, advancing
  `last_triggered_at`, no new row, no publish. Outside the window,
  suppression checks a tenant suppression-rule time-window match and
  whether the most recent alert in the same `dedup_group_id` was
  acknowledged recently — either → `status: 'suppressed'`, still
  queryable (§2.2 rule 4), no publish. Otherwise → `status: 'open'`,
  publish to `alertRaised`.
- **Escalation** (`AlertEscalationSchedulerService`, `@Cron('*/5 * * * *')`,
  same shape as Phase 3's schedulers, same `MIGRATOR_PG_POOL` cross-tenant
  pattern ADR-0066 established): scans open `warning` alerts past the
  tenant's escalation threshold, bumps to `critical`, sets `escalated_at`,
  re-publishes. No real notification fan-out (ADR-0069).
- **GraphQL**: `AlertResult` type (`src/alerting/types.ts`, same
  co-located-with-domain convention as `src/live-state/types.ts`).
  `activeAlerts` — tenant from context, `status IN ('open',
  'acknowledged')`. `acknowledgeAlert(alertId)` — requires both
  `requireTenantId()` and the new `requireActorId()`. `alertRaised` — same
  in-process PubSub pattern as Phase 4's `queueLiveStateUpdated`, with the
  same already-documented gap (no WS-connection-level tenant
  verification, ADR-0068) applying here too. Takes an explicit `tenantId`
  argument (not just the spec'd `orgUnitId`, which is always `null` on
  every real payload this module produces — see assumption 5) for the
  same reason `queueLiveStateUpdated` needed an explicit `queueId`: a
  `graphql-ws` connection doesn't carry `TenantContextService`'s
  HTTP-header-bound context.
- **`TenantContextService` widened**: `TenantContextStore` gains an
  optional `actorId`, bound from a new `X-Actor-Id` header (same
  header-trust placeholder convention as `X-Tenant-Id`). Additive — every
  existing caller that only needs `tenantId` is unaffected.

## Blast radius

New `src/alerting/` directory (7 services/entities + 1 module), one new
migration (additive schema only). `QueueMetricsUpdatedConsumerService`
gains one call to `AlertEngineService` after its existing Redis write — no
change to that write itself. `TenantContextStore` gains one optional
field. `ConsumersModule` and `IntradayGraphQLModule` each gain one new
import. No change to Phases 1–4's own pipelines or resolvers. No
`docker-compose.yml` change, no new npm dependency.

## Rollback plan

Revert the migration (`DROP TABLE intraday.alert, intraday.alert_policy`
in `down()`), delete `src/alerting/` and
`src/graphql/resolvers/alert.resolver.ts`, remove the one call site in
`QueueMetricsUpdatedConsumerService` and the two module imports, revert
`TenantContextStore`'s `actorId` field and the middleware's `X-Actor-Id`
read. Nothing outside this phase depends on any of it.

## Explicit assumptions

1. `last_triggered_at`/`escalated_at`/`acknowledged_by`/`acknowledged_at`/
   `resolved_at` extend §2.1's literal `Alert` schema — necessary for the
   pipeline to function at all, not arbitrary additions.
2. Alert policy (dedup/suppression/escalation windows, suppression rules)
   is a small, self-contained `intraday.alert_policy` table, not
   integrated with Module 01's generic `Policy` versioning system.
3. `acknowledgeAlert` needs an actor identity `TenantContextService`
   didn't carry before this phase — widened to optionally carry `actorId`
   from `X-Actor-Id`, same header-trust convention as `X-Tenant-Id`.
4. Escalation's "wider notification scope" (§5a point 3) is not a real
   notification fan-out — no delivery mechanism exists in this module.
   Implemented as a severity bump + `alertRaised` re-publish only.
5. `org_unit_id` on `Alert` is always `null` — no upstream payload in this
   module's data model carries it, the same honest gap Phase 3's rollups
   already flagged. `activeAlerts`/`alertRaised`'s `orgUnitId` argument is
   accepted per the API shape but not currently filterable on real data.
6. Only one detector exists this phase: queue service-level breach. Any
   `agent.state_changed`-triggered alert type (e.g. an adherence-deviation
   alert) is not built — §5a's own example is queue-focused, and a second
   detector without a second concrete signal to justify it would be
   speculative.
7. Suppression/escalation policy is configured only via direct writes to
   `intraday.alert_policy` — no admin mutation/UI exists to manage it this
   phase.

## Out of scope for this phase

- Real notification delivery/fan-out on escalation (assumption 4).
- An admin mutation/UI for managing `alert_policy` rows (assumption 7).
- A full alert audit/history GraphQL query (suppressed + resolved) beyond
  `activeAlerts`'s open/acknowledged scope.
- Org-unit-scoped alerts (assumption 5).
- Any detector beyond queue service-level breach (assumption 6).
- `ReallocationAction`, `reallocationSuggested`, `approveReallocation` —
  Phase 6.
- `graphql-ws` connection-level tenant authentication — same gap ADR-0068
  already flagged, not re-litigated here.
- Horizontal-scaling-safe PubSub, the 100k+-agent load test — Phase 7.
- Multi-region — Phase 8.

## Verification

- `npm run typecheck && npm run build && npm run lint && npm test` — all
  clean; 137 unit tests across 33 suites (7 new spec files this phase:
  `AlertPolicyService`'s suppression-rule matching including a
  midnight-wrapping window, `AlertPipelineService`'s dedup/suppression/
  escalation decision logic with a mocked repository, `AlertEngineService`'s
  threshold/severity computation, `AlertEscalationSchedulerService`
  including its re-entrancy guard, `AlertQueryService`,
  `AlertAcknowledgeService`, `AlertResolver`'s delegation — plus additive
  coverage on `TenantContextService`/`TenantContextMiddleware` for the new
  `actorId` handling and on the existing `QueueMetricsUpdatedConsumerService`
  spec for its new `AlertEngineService` call).
- Migration run against real local Postgres; RLS (`rowsecurity = t` on
  both tables), the three `intraday.alert` indexes, and grants
  (`agno_intraday_app`: `SELECT, INSERT, UPDATE`, no `DELETE`, matching
  the migration's intent) confirmed via `psql`.
- End-to-end against real Redis/NATS/Postgres, booted service: hand-published
  two `queue.metrics_updated` breach messages for the same queue within
  the dedup window — confirmed exactly one `Alert` row, `last_triggered_at`
  advanced on the second, no second row. Set a suppression rule and a
  1-minute dedup window for the tenant, published a third breach outside
  the dedup window matching the rule — confirmed a second row sharing
  `dedup_group_id` with `status: 'suppressed'`. Ran `acknowledgeAlert` via
  a real GraphQL request with `X-Tenant-Id`/`X-Actor-Id` headers, confirmed
  `status`/`acknowledged_by`/`acknowledged_at` landed. Published a
  metrics update with the queue back at/above target, confirmed
  auto-resolution (`status: 'resolved'`). Let the 5-minute escalation
  cron tick with a 1-minute escalation threshold, confirmed an open
  `warning` alert flipped to `critical` with `escalated_at` set. Subscribed
  to `alertRaised` over `graphql-ws`, confirmed a real open-alert publish
  arrived.
