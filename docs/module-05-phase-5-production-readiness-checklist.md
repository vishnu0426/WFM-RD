# Module 05 Phase 5 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases
(§0.5), matching Phase 1–4's own format and honesty bar.

## Delivered in this phase (application code)

- [x] `intraday.alert`/`intraday.alert_policy` schema (RLS, three
      indexes on `alert`, `SELECT/INSERT/UPDATE`-only grants for
      `agno_intraday_app`, no `DELETE`) — migrated against real local
      Postgres, RLS/indexes/grants confirmed via `psql`.
- [x] `AlertEngineService`'s `service_level_breach` detector, fed by
      Phase 4's `QueueMetricsUpdatedConsumerService` — proven end-to-end
      with real hand-published `queue.metrics_updated` NATS messages, not
      just unit-tested.
- [x] `AlertPipelineService`'s dedup — two breaches for the same queue
      within the tenant's dedup window collapse into one `Alert` row with
      `last_triggered_at` advanced, no duplicate row — proven end-to-end
      against real Postgres.
- [x] `AlertPipelineService`'s suppression — a tenant-configured
      time-window `suppression_rules` match produces a `status:
      'suppressed'` row sharing the prior `dedup_group_id`, still
      queryable, no `alertRaised` publish — proven end-to-end.
- [x] `AlertPipelineService`'s auto-resolution — a queue metrics update
      that clears the breach flips the active alert to `status:
      'resolved'` — proven end-to-end (no `resolveAlert` mutation exists
      in §4.1; this is the only path to `resolved`).
- [x] `AlertEscalationSchedulerService` (`@Cron('*/5 * * * *')`) — an
      open `warning` alert past the tenant's escalation threshold flips
      to `critical`, `escalated_at` set, re-published to `alertRaised` —
      proven end-to-end by letting a real cron tick fire against a
      1-minute test threshold and watching a live `graphql-ws`
      subscription receive the re-publish.
- [x] `activeAlerts` GraphQL query — tenant from context,
      `open`/`acknowledged` only — proven end-to-end (confirmed a
      suppressed row is correctly excluded).
- [x] `acknowledgeAlert` GraphQL mutation — requires both
      `X-Tenant-Id` and the new `X-Actor-Id`; fails closed with
      `ACTOR_CONTEXT_MISSING` (400) when the actor header is absent —
      both the failure and success paths proven end-to-end against a
      real running service.
- [x] `alertRaised` GraphQL subscription over `graphql-ws` — proven
      end-to-end with a real WebSocket client: received both the initial
      open-alert push and the later escalation re-push on the same
      connection.
- [x] `TenantContextStore`'s `actorId` widening (`X-Actor-Id` header,
      `requireActorId()`) — additive, every existing `tenantId`-only
      caller unaffected.
- [x] Unit test suite (7 new spec files: `AlertPolicyService`'s
      suppression-rule matching including a midnight-wrapping window,
      `AlertPipelineService`'s dedup/suppression/escalation decision
      logic with a mocked repository, `AlertEngineService`'s
      threshold/severity computation, `AlertEscalationSchedulerService`
      including its re-entrancy guard, `AlertQueryService`,
      `AlertAcknowledgeService`, `AlertResolver`'s delegation — plus
      additive coverage on `TenantContextService`/
      `TenantContextMiddleware` for `actorId` and on
      `QueueMetricsUpdatedConsumerService`'s spec for its new
      `AlertEngineService` call) — 137 tests across 33 suites, all
      passing, no live infra required to run `npm test`.
- [x] One ADR (0069) covering the four load-bearing decisions this phase
      made without existing precedent to copy.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Real notification delivery/fan-out on escalation.** A
      `critical`-severity, unacknowledged, escalated alert produces no
      email/Slack/SMS — only a GraphQL subscription push to whoever
      happens to be connected. Real fan-out is Module 01's
      `NotificationService`, out of reach without new cross-module work
      (ADR-0069's consequences).
- [ ] **An admin mutation/UI for managing `alert_policy` rows.**
      Suppression rules and dedup/suppression-ack/escalation windows are
      configurable only via direct writes to `intraday.alert_policy` —
      this phase's own verification set one by hand via `psql`. A tenant
      that never gets a row runs on `DEFAULT_ALERT_POLICY` indefinitely,
      which is a valid, expected state, not a bug.
- [ ] **A full alert audit/history query.** `activeAlerts` only returns
      `open`/`acknowledged` — querying suppressed/resolved alerts for
      audit purposes isn't built.
- [ ] **Org-unit-scoped alerts.** `org_unit_id` is always `null` — no
      upstream payload in this module's data model carries it, the same
      honest gap Phase 3's rollups already flagged.
- [ ] **Any alert detector beyond queue service-level breach.** No
      `agent.state_changed`-derived alert type (e.g. adherence deviation)
      exists — §5a's own example is queue-focused, and this phase didn't
      speculate a second one.
- [ ] **`reallocationSuggested`/`approveReallocation`.** No
      `ReallocationAction` entity exists anywhere in this codebase yet —
      Phase 6.
- [ ] **`graphql-ws` connection-level tenant authentication.** Same gap
      ADR-0068 already flagged for `queueLiveStateUpdated` — a client can
      subscribe to `alertRaised` for any `tenantId` it already knows,
      without the WebSocket connection proving ownership. Not
      re-litigated or worsened by this phase, but not closed either.
- [ ] **Real tenant/actor authentication.** `X-Tenant-Id`/`X-Actor-Id` are
      trusted as-is — the same class of gap this platform has closed once
      (ADR-0014 → ADR-0049) and left open in scheduling-service and
      Phase 4's own surface already; `X-Actor-Id` is a new instance of
      the identical gap, not a new kind of one.
- [ ] **The §0.5 SLOs proven at scale.** No load test has run against the
      alert pipeline specifically — Phase 7, same as every prior phase's
      own checklist.
- [ ] **Terraform/Vault, rate limiting, penetration testing, SAST/SBOM.**
      Same explicit non-goals already stated platform-wide for every
      module's early phases — not re-litigated per phase.
