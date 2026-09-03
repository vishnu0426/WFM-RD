# Module 05 Phase 1 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases (§0.5),
matching Module 01/02/03/04's phase-1 checklists' format and honesty bar.
This module is explicitly flagged as the platform's most likely place to
expose scaling problems first — this checklist is deliberately conservative
about what "done" means here, same posture Module 04's own Phase 1
checklist took for its own highest-risk module.

## Delivered in this phase (application code)

- [x] `AgentLiveState`/`QueueLiveState` Redis key schema
      (`tenant:{tenantId}:agent:{employeeId}` /
      `tenant:{tenantId}:queue:{queueId}`, §2.1) implemented in
      `IntradayRedisService`, with `last_updated_at` stamped on every write
      and null-field clearing via `HDEL` (not a stale-field leak), proven by
      round-trip unit tests including the mid-shift-clear case.
- [x] Fail-*visible* Redis posture (ADR-0062): every data-path method
      throws `IntradayRedisUnavailableError` on a Redis error rather than
      swallowing it, an explicit, documented departure from the root app's
      fail-open `RedisService` — proven by unit tests asserting the guard/
      service/health-controller all propagate or act on the failure rather
      than hiding it.
- [x] `POST /v1/intraday/tenants/:tenantId/activity-events` (§4.2):
      `HmacSignatureGuard` verifies the `t=<unix_ms>,v1=<hmac>` shape
      (ADR-0046's convention, in reverse) with `timingSafeEqual`, rejecting
      missing/malformed headers, stale timestamps (replay protection), wrong
      secrets, and tampered bodies — proven by unit tests for every one of
      those cases.
- [x] Idempotency: Redis `SET...EX...NX` lock keyed on the ACD system's own
      event id (not a client `Idempotency-Key` header), fail-*closed* on a
      Redis error (the deliberate contrast with ADR-0047's fail-open lock —
      see ADR-0062's consequences), with best-effort lock release on a
      downstream NATS-publish failure so a legitimate ACD retry after a
      `503` isn't silently swallowed as a duplicate — proven by unit tests
      covering first-sighting/duplicate/redis-failure/nats-failure-releases-
      lock.
- [x] NATS JetStream publisher skeleton: `IntradayNatsClientService`
      (lazy connect, reconnect cooldown, mirrors `core-eventing`'s pattern
      per ADR-0039's precedent) and per-employee-keyed subjects
      (`agno.intraday.agent.state_changed.v1.{employeeId}`, ADR-0063) are
      real and used by `IngestionService` on every accepted event — nothing
      in this repo consumes these subjects yet (Phase 2).
- [x] `scripts/provision-nats-streams.ts` (the platform's shared,
      idempotent provisioning script) additively gains `AGNO_INTRADAY_EVENTS`
      (24h retention, §0.5's FinOps ask to state an actual number) and
      `AGNO_INTRADAY_DLQ` (180d, matching precedent) — every existing stream
      entry untouched.
- [x] `/healthz` (liveness, no dependency checks) / `/readyz` (Redis
      PING-blocking — `503` on unreachable, the first concrete instance of
      ADR-0062's contract) / `/metrics` (Prometheus text exposition,
      `http_request_duration_seconds`/`_total`,
      `intraday_ingestion_events_total{result}`,
      `intraday_redis_operation_duration_seconds`,
      `intraday_nats_publish_duration_seconds` — §7's "Redis write latency
      distribution" ask, satisfied for the one write path that exists this
      phase).
- [x] Standard REST error envelope (`{ error: { code, message, details } }`,
      ADR-0015's shape) via `DomainErrorFilter`, mapping
      `INVALID_SIGNATURE` → `401` and `UPSTREAM_UNAVAILABLE` → `503`.
- [x] OpenTelemetry auto-instrumentation wired at boot (same
      import-order constraint and no-op-safe-without-a-collector posture as
      the root app's `tracing.ts`), health/metrics scrape paths excluded
      from trace volume.
- [x] Unit test suite (guard signature/replay/tampering cases, ingestion
      service dedupe/publish/lock-release/error-mapping, Redis key builders,
      Redis hash round-trip including null-clearing, NATS subject builders,
      health controller ok/degraded paths) — no live Redis/NATS/Postgres
      required to run `npm test`.
- [x] Two ADRs (0062 Redis fail-visible posture, 0063 NATS per-employee
      ordering + the Node→Go extraction contract boundary), written now per
      §0.5's explicit instruction, not deferred until an extraction is
      already underway.
- [x] No `docker-compose.yml` change needed — verified this service boots
      and serves `/healthz`/`/readyz`/the ingestion endpoint against the
      already-running `redis`/`nats` containers docker-compose already
      provisions for Module 01/02.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **`AgentLiveState`/`QueueLiveState` populated by real ACD traffic.**
      `IntradayRedisService.write*` is real and tested in isolation, but
      nothing in this phase's request path calls it — the ingestion
      endpoint only acquires an idempotency lock and publishes to NATS.
      Nothing consumes `agno.intraday.agent.state_changed.v1.*` yet. Do not
      treat this phase's passing tests as evidence that a live dashboard
      would show correct data end to end — there is no consumer under test
      yet. Phase 2.
- [ ] **`scheduled_activity` preload from Module 04's published `Schedule`,
      and the mid-shift schedule-change update path (§2.2 rule 2).**
      Requires the Phase 2 consumer and a real integration point with
      Module 04 — neither exists yet.
- [ ] **A durable per-tenant webhook secret store.** `INTRADAY_WEBHOOK_SECRETS`
      is a local env-config JSON map, explicitly flagged in the design doc
      as a stand-in. A production deployment needs a real secret store
      (gRPC to Module 01's tenant config, or a local table once this
      service has Postgres) with rotation support — not built here.
- [ ] **`AdherenceEvent`, the `intraday` Postgres schema/role/RLS,
      partitioning, and rollups (§3.4).** No Postgres exists in this service
      at all yet — Phase 3.
- [ ] **§6.1's full `dataFreshness` response-envelope contract.** This
      phase's `/readyz` proves Redis errors are surfaced, not the full
      envelope shape a live-read API needs — there is no live-read API
      surface yet (Phase 4) to attach it to.
- [ ] **The chaos/game-day exercise §0.5 names specifically for this
      module** (kill the Redis primary, verify the degradation path
      engages; kill a NATS consumer, verify state catches back up rather
      than drifting). Cannot be run meaningfully before Phase 2 gives this
      module a consumer and a dashboard read path to observe degrading.
      Phase 7.
- [ ] **The 100k+-agent release-gate load test (§0.5, §7).** Explicitly
      named a release-gate artifact, not a nice-to-have — and explicitly
      *not* satisfied by this phase's key-schema/ordering decisions.
      Per-employee subject ordering is necessary infrastructure for that
      test to have a chance of passing; it is not the test itself. Cannot
      be run meaningfully before Phase 2+ gives this module a real
      write/consume pipeline to load-test in the first place.
- [ ] **GraphQL surface (`agentLiveState`, `queueLiveState`, subscriptions,
      `reportActivityChange`/`approveReallocation`/`acknowledgeAlert`
      mutations) and the REST snapshot fallback.** Node/Module 05's own
      surface in a later phase (Phase 4) — not built at all in this phase.
- [ ] **Alert dedup/suppression/escalation pipeline (§5a) and
      `ReallocationAction`/`ai_rationale`/auto-execute (§6 in the entity
      table, Phase 6).** No `Alert` or `ReallocationAction` entity exists
      yet in any store.
- [ ] **Multi-region Redis/NATS topology (§6.2), regional key/subject
      routing.** This phase's keys/subjects are region-agnostic strings; no
      region-awareness has been designed in yet. Phase 8, and even then only
      the application-layer portion — actual multi-region infrastructure
      provisioning is an explicit non-goal of this module per §9.
- [ ] **Terraform for real Postgres/Redis/NATS provisioning, Vault for
      credential issuance.** Same gap already flagged in every prior
      module's own Phase 1 checklist — not re-litigated per module.
- [ ] **In-process or gateway-level rate limiting on the ingestion
      endpoint**, **penetration testing / SOC2 / ISO27001**,
      **SAST / dependency scanning / SBOM.** Same explicit non-goals already
      stated platform-wide for Phase 1 of every module.
