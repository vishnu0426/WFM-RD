# Module 05 Phase 1 Design Doc — Intraday/Real-Time Management: Redis Schema & Ingestion Skeleton

**Status:** Approved for implementation
**Owner:** Intraday pod (Module 05) — Principal Performance Engineer owns the
Redis/NATS write-path design per §0, since this module is explicitly
flagged as the platform's most likely place to expose scaling problems
first.
**Scope:** §2.1's `AgentLiveState`/`QueueLiveState` Redis key schema and
client (`IntradayRedisService`), the §4.2 webhook ingestion endpoint
(`POST /v1/intraday/tenants/:tenantId/activity-events` — signature
verification + idempotency), and a §4.3 NATS JetStream publishing skeleton
(`IntradayNatsClientService`, subject provisioning). No Postgres,
`AdherenceEvent`, schema, or role — Phase 3. No GraphQL — Phase 4. No NATS
consumer that actually populates `AgentLiveState`/`QueueLiveState` from real
traffic — Phase 2. No alert pipeline or reallocation — Phase 5/6. Does not
call Module 01/02/03/04 over gRPC or otherwise in this phase — the one
piece of cross-module data this phase would naturally want (a durable,
per-tenant webhook secret, most naturally owned by Module 01's tenant
config) is deliberately stubbed with local env config instead (Explicit
assumption 1), so this phase has zero live dependency on any other module's
running code.

## Problem

Module 05 runs at a fundamentally different tempo than Modules 01–04:
sub-second state changes at high frequency, not request/response or async
batch jobs. The module prompt is explicit that forcing this into the same
transactional-Postgres shape used elsewhere would be a mistake — Redis is
the deliberate, justified system of record for *current* state here. Phase
1's job is to stand up that Redis presence and the ingestion path that will
eventually feed it, correctly, before anything downstream (the Phase 2
consumer, Phase 4's live-read API, Phase 7's load test) is built on top of
assumptions that turn out to be wrong. Two decisions matter enough to need
their own ADRs, made now rather than retrofitted:

1. **Every other Redis consumer in this platform is a fail-open cache.**
   Root's `RedisService` swallows errors by design — Redis backs
   performance optimizations only, and every caller has a correct Postgres
   fallback. Module 05 has no such fallback: Redis *is* the record of
   "what is this agent doing right now." Copying the fail-open posture
   unmodified would directly violate §6.1's non-negotiable — "a dashboard
   that looks live but isn't is worse than one that visibly says data may
   be delayed" — because a swallowed Redis error is precisely how a
   dashboard ends up looking live while quietly showing nothing true. See
   ADR-0062.
2. **§4.3 requires per-employee ordering; NATS JetStream doesn't give it
   for free the way a Kafka partition key would.** The source spec assumed
   Kafka; §1 already overrides that platform-wide, but the *ordering
   mechanism* specifically has to be redesigned, not carried over
   uncritically — and §0.5 asks that the subject/consumer boundary be
   written down as a frozen contract now, anticipating the module's
   flagged future Node→Go extraction. See ADR-0063.

Beyond those two, this phase follows the precedent Module 03/04 already set
for standing up a new deployable service in this platform: reuse the
platform's existing conventions (error envelope, HMAC signing shape,
Redis/idempotency idiom, observability wiring) rather than inventing
parallel ones, and ship a real, tested ingestion path rather than a stub —
"webhook ingestion endpoint with signature verification + idempotency" is
Phase 1 scope by the module prompt's own §8 build-phase list, not a Phase 2
concern.

## Decision

A new standalone deployable, `intraday-service/` (Node.js/NestJS), sibling
to `scheduling-service/`/`forecasting-service/` rather than a new module
folded into the root `src/` app — consistent with how Modules 03/04 were
each stood up as independently deployable services, and directly serving
§0.5's stated reason this module specifically (unlike 01–04) needs to be
independently scalable/extractable. Runs outside `docker-compose.yml`
against the already-provisioned Redis/NATS containers, same as
scheduling-service/forecasting-service — no new infrastructure container is
needed this phase. **No Postgres at all in this phase** — deferred to
Phase 3 alongside `AdherenceEvent`, keeping this phase schema/role/RLS-free
and matching the module's own phase breakdown, which names Postgres only
from Phase 3 onward.

**Redis** (`src/redis/`): `IntradayRedisService`, an independent class (not
importing root's `RedisService`) implementing §2.1's key schema —
`tenant:{tenantId}:agent:{employeeId}` and `tenant:{tenantId}:queue:{queueId}`
hashes, `last_updated_at` stamped by the service on every write, never
caller-supplied. Fail-*visible*: data-path methods throw
`IntradayRedisUnavailableError` on a Redis error rather than swallowing it
(ADR-0062); `ping()` is the deliberate single fail-safe exception, since it
exists to *report* degraded status, not to perform a data operation. A
field set to `null` is cleared via `HDEL` in the same pipeline as the
`HSET` for non-null fields — a naive "just omit it from HSET" would leave a
stale value from a previous write lingering, which matters once Phase 2's
mid-shift `scheduled_activity` updates (§2.2 rule 2) depend on this being
correct. Nothing in this phase calls the write helpers from real traffic —
they're built and round-trip-tested now so Phase 2's consumer has a proven
client to call against, not because anything populates live state yet.

**Ingestion** (`src/ingestion/`): `POST
/v1/intraday/tenants/:tenantId/activity-events`. `tenantId` is a URL path
segment rather than derived from a JWT/header (root's
`TenantContextMiddleware` convention doesn't apply — the caller is a
server-to-server ACD/CCaaS webhook, not an authenticated user session).
`HmacSignatureGuard` verifies the same `t=<unix_ms>,v1=<hmac>` shape
ADR-0046 already established for this platform's *outbound* webhook
signing, in reverse: HMAC-SHA256 over `${timestamp}.${rawBody}`, compared
with `timingSafeEqual` (the same idiom `PkceService.verify` already uses).
`main.ts` enables Nest's `rawBody: true` option specifically so the guard
signs the exact bytes the ACD system sent, not a re-serialization of the
parsed body. On success, `IngestionService` acquires a Redis
`SET...EX...NX` idempotency lock keyed on the ACD system's own event id
(`acquireIngestionIdempotencyLock`, 24h default TTL) — first sighting
publishes `AgentStateChangedPayload` to
`agno.intraday.agent.state_changed.v1.{employeeId}` and returns `202`; a
duplicate returns `200` without republishing. If the NATS publish fails
*after* the lock was already acquired, the lock is released
(`releaseIngestionIdempotencyLock`, best-effort/fail-open — the one other
deliberate exception to ADR-0062's rule) before surfacing `503` — without
this, a legitimate ACD retry of the same event would be silently treated as
a duplicate for the rest of the TTL window, exactly the kind of
looks-fine-but-isn't failure §6.1's spirit rules out. No
`AgentLiveState`/`QueueLiveState` write happens in the ingestion path
itself — per §5's architecture, that's the Phase 2 NATS consumer's job,
kept structurally separate so it can be added without touching this
controller/service.

**NATS** (`src/nats/`): `IntradayNatsClientService`, an independent copy of
`core-eventing`'s `NatsClientService` (ADR-0039's precedent: each
module/service owns its client rather than sharing one). Subjects and
payload shapes live in `subjects.ts` — `agentStateChangedSubject(employeeId)`
appends the employee id as a subject suffix specifically to give JetStream's
per-subject ordering the semantics §4.3 needs (ADR-0063).
`scripts/provision-nats-streams.ts` (the platform's existing, shared,
idempotent provisioning script) gets an additive `AGNO_INTRADAY_EVENTS`
stream entry (wildcarded subjects, so the per-employee suffix doesn't need
per-employee stream registration) plus `AGNO_INTRADAY_DLQ`, both at 24h/180d
retention respectively, matching precedent and §0.5's FinOps ask to state
an actual number rather than leaving storage unbounded.

Health/observability mirror the root app's Phase 7 conventions
(`/healthz`/`/readyz`/`/metrics`, `prom-client`, OTel auto-instrumentation)
scaled to this phase's actual surface — `/readyz` returns `503` when Redis
is unreachable (not just reported, unlike root's Redis-non-fatal posture),
the first concrete instance of ADR-0062's fail-visible contract.

## Blast radius

- Entirely new directory (`intraday-service/`) plus two new docs and two
  new ADRs — zero modification to any Module 01–04 table, migration,
  schema, or running code path.
- One additive edit to a shared file: `scripts/provision-nats-streams.ts`
  gains two new stream entries; every existing entry is untouched.
- No `docker-compose.yml` change — runs as a local process against the
  already-running Redis/NATS containers, same posture as
  scheduling-service/forecasting-service.
- No Postgres schema, role, or migration in this phase at all.
- No deployed traffic depends on this service yet — nothing else in the
  platform calls it or subscribes to its subjects.

## Rollback plan

Delete `intraday-service/`, revert the additive block in
`provision-nats-streams.ts` (removing `AGNO_INTRADAY_EVENTS`/
`AGNO_INTRADAY_DLQ` is a normal, safe JetStream stream deletion — nothing
has published meaningful history to them outside of manual verification),
remove the two new docs/ADRs. Nothing external references this service
yet, so rollback is a non-event now — this stops being true once Phase 2+
puts a real consumer and dashboard traffic behind these subjects/keys.

## Explicit assumptions (spec was ambiguous or silent here)

1. **Per-tenant webhook secret storage is deferred; `HmacSignatureGuard`
   resolves secrets from a `tenantId -> secret` JSON map in
   `INTRADAY_WEBHOOK_SECRETS` env config.** The module prompt doesn't say
   where inbound ACD/CCaaS HMAC secrets live — unlike outbound webhook
   signing (ADR-0046), where this platform generates and stores the secret
   itself, an inbound secret is credential material shared with (or issued
   by) each tenant's ACD vendor, most naturally a Module 01 tenant-config
   concern. Building that store now would mean building Postgres
   persistence and a gRPC contract this phase's own scope explicitly
   excludes. A durable per-tenant store (via gRPC to Module 01, or a local
   table once this service has Postgres in Phase 3) is real future work,
   landing no later than Phase 3.
2. **No Postgres at all in Phase 1, including for the ingestion
   idempotency ledger.** Dedup uses a Redis `SET...EX...NX` lock (ADR-0047's
   idiom, own copy), not a durable table — acceptable because this only
   guards against ACD webhook-retry duplicates within the TTL window; it is
   not this system's compliance record (`AdherenceEvent`, Phase 3, is).
   Unlike ADR-0047's own lock (which fails open), this one fails *closed*
   per ADR-0062 — see that ADR for why the two idempotency mechanisms in
   this platform now have opposite failure postures, deliberately.
3. **Redis hash write/read helpers are schema- and round-trip-tested, not
   production-wired.** `IntradayRedisService.write*` is real, tested code —
   not a stub — but nothing in this phase's request path calls it from
   real ACD traffic. That's Phase 2's NATS consumer's job. Matches Module
   04 Phase 1's precedent: real-but-not-yet-consumed scaffolding, not a
   half-finished implementation.
4. **`/readyz`'s Redis-fatal posture is this phase's starting point, not
   the finished §6.1 contract.** This endpoint proves Redis errors are
   surfaced rather than swallowed (satisfying ADR-0062), but the full
   `dataFreshness` response envelope §6.1 describes belongs on a live-read
   API — there isn't one yet (Phase 4's GraphQL/REST snapshot). Building
   that envelope now would mean guessing its shape before the API it
   attaches to exists.
5. **`ActivityEventDto` is deliberately narrow**: `sourceEventId`,
   `employeeId`, `currentActivity`, `activityStartedAt`, optional `siteId`/
   `queueId`. It does not carry `scheduledActivity` — per §2.2 rule 2, that
   field is pre-loaded into `AgentLiveState` from Module 04's published
   `Schedule` at shift start, never supplied by the ACD webhook itself.
   Getting this field list right now avoids a breaking DTO change once
   Phase 2's consumer needs to reconcile a real payload against a real
   schema.

## Out of scope for this phase (do not build yet)

- `AgentLiveState`/`QueueLiveState` populated by real traffic, per-employee
  ordered consumption, `scheduled_activity` preload from Module 04's
  published `Schedule` — Phase 2.
- `AdherenceEvent`, the `intraday` Postgres schema/role/RLS, partitioning,
  and the rollup-table strategy — Phase 3.
- GraphQL queries/mutations/subscriptions, the REST snapshot fallback
  (`GET /v1/intraday/queues/{id}/live`) — Phase 4.
- Alert dedup/suppression/escalation pipeline (§5a) — Phase 5.
- `ReallocationAction`, mandatory `ai_rationale`, the feature-flagged
  auto-execute path — Phase 6.
- The full §6.1 `dataFreshness` degradation contract on a live-read API,
  and the 100k+-agent release-gate load test — Phase 7.
- Multi-region Redis/NATS topology (§6.2) — Phase 8.
- Durable per-tenant webhook-secret storage (see Explicit assumption 1).
