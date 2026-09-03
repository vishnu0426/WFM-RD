# Module 05 Phase 6 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases
(§0.5), matching Phase 1–5's own format and honesty bar.

## Delivered in this phase (application code)

- [x] `intraday.reallocation_action` schema (RLS, two indexes, three
      CHECK constraints including `ai_rationale`'s conditional
      requirement, `SELECT/INSERT/UPDATE`-only grants for
      `agno_intraday_app`, no `DELETE`) — migrated against real local
      Postgres, RLS/indexes/constraints/grants confirmed via `psql`.
- [x] Queue-membership reverse index (`queueAgentsKey`) and tracked-queue
      registry (`trackedQueueKey`) in Redis — proven end-to-end: a real
      `agent.state_changed` message populated real membership, and
      `approveReallocation` moving an employee correctly updated both the
      forward `AgentLiveState.queue_id` and the reverse index in the same
      call.
- [x] `ReallocationRecommendationService`'s donor-selection heuristic
      (largest service-level surplus above a documented 10-point
      threshold, real tracked employee IDs, never fabricated) — proven
      end-to-end with real hand-published NATS messages, not just
      unit-tested.
- [x] The repeat-guard — proven end-to-end: a second breach tick for the
      same donor/target pair produced no duplicate row.
- [x] `ai_rationale` — a real, deterministic, metrics-citing jsonb object
      on every suggested row, matching Module 01's own convention (never
      a real LLM/ML call) — proven end-to-end, not just asserted in a
      unit test.
- [x] `approveReallocation` GraphQL mutation / `POST
      /v1/intraday/reallocations/:id/approve` REST endpoint, sharing
      `ReallocationApprovalService` — proven end-to-end: `suggested` →
      `approved` → `executed` in one call, the affected employee's
      `AgentLiveState.queueId` actually changed in Redis.
      `REALLOCATION_NOT_FOUND` (404) and `REALLOCATION_NOT_SUGGESTED`
      (409, a real state conflict) both confirmed against a running
      service.
- [x] `pendingReallocations` GraphQL query (the necessary §4.1 gap this
      phase closes) — proven end-to-end, correctly excludes an
      already-executed row.
- [x] `reallocationSuggested` GraphQL subscription over `graphql-ws` —
      proven end-to-end with a real WebSocket client receiving a real
      push triggered by a hand-published NATS message.
- [x] Feature-flagged auto-execute
      (`INTRADAY_REALLOCATION_AUTO_EXECUTE_ENABLED`, off by default per
      §8) — proven end-to-end: with the flag on, a fresh breach scenario
      went straight to `status: 'auto_executed'` with the employee's
      queue actually moved, no `approveReallocation` call made.
- [x] Publishing to `agno.intraday.reallocation.suggested.v1` — this
      module's own producer role for a subject reserved since Phase 1
      but unused until now (§4.3).
- [x] Unit test suite (9 new spec files, plus additive coverage on
      `QueueMetricsUpdatedConsumerService`'s existing spec) — 168 tests
      across 39 suites, all passing, no live infra required to run `npm
      test`.
- [x] One ADR (0070) covering the four load-bearing decisions this phase
      made without existing precedent to copy.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Real ACD/telephony call-routing integration.** "Execution" only
      updates `AgentLiveState.queueId` in Redis — no real system actually
      re-routes the affected employee's calls. No such integration
      exists anywhere in this repo (design doc assumption 7, same class
      of gap as Phase 5's escalation having no real notification
      fan-out).
- [ ] **`rejectReallocation`.** No mutation/endpoint exists in §4 —
      `status: 'rejected'` is schema-modeled but unreachable this phase
      (assumption 6).
- [ ] **Moving more than one employee per suggestion.** A conservative,
      minimal heuristic (assumption 4) — a real staffing gap larger than
      one agent isn't addressed by a single suggestion.
- [ ] **Root `org.feature_flags` integration for the auto-execute
      gate.** A plain env var instead (assumption 3) — no per-tenant
      auto-execute configuration exists, it's all-or-nothing for the
      whole service.
- [ ] **A full reallocation audit/history query.** `pendingReallocations`
      only returns `suggested` rows — querying approved/executed/
      auto_executed/rejected history for audit purposes isn't built.
- [ ] **`graphql-ws` connection-level tenant authentication.** Same gap
      ADR-0068 already flagged for `queueLiveStateUpdated`/`alertRaised` —
      not re-litigated or worsened by this phase, but not closed either.
- [ ] **Real tenant authentication.** `X-Tenant-Id` is trusted as-is —
      the same class of gap this platform has closed once (ADR-0014 →
      ADR-0049) and left open in scheduling-service and this service's
      own surface already.
- [ ] **The §0.5 SLOs proven at scale, and specifically the new
      read-before-write cost on `AgentStateChangedConsumerService`'s hot
      path.** No load test has run — Phase 7, same as every prior
      phase's own checklist, but this phase's own design doc explicitly
      flags this one addition as worth watching closely.
- [ ] **Terraform/Vault, rate limiting, penetration testing, SAST/SBOM.**
      Same explicit non-goals already stated platform-wide for every
      module's early phases — not re-litigated per phase.
