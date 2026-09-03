# Module 05 Runbook — Intraday/Real-Time Management

Operational reference for `intraday-service` (Phases 1-8). Every check
below is a direct SQL query against `intraday.*` (any role with
`SELECT` - `agno_migrator` locally, since RLS's `ENABLE`-not-`FORCE`
posture means only the table owner sees cross-tenant rows), a
`redis-cli` command, or a scrape of the one `/metrics` endpoint
(`GET :8200/metrics`) - see `observability/grafana-dashboard-module-05.json`
for the panelled view of the same data.

## 0. One process, not a worker pool

Unlike Module 04 (separate API + worker processes), `intraday-service`
is a single process (`npm run start:prod` / `node dist/src/main`):
the REST/GraphQL API, every durable JetStream consumer
(`DurableJetStreamConsumer` subclasses, `src/consumers/`,
`src/adherence/`, `src/live-state/`, `src/reallocation/`), and every
`@Cron` scheduler all run in-process, in the same event loop. There is
no separate "worker" to start or scale independently - horizontal scale
today means running more full instances (each with its own durable
JetStream consumer bindings), which is **not yet safe** for the
in-process `graphql-subscriptions` `PubSub` (ADR-0068's own deferred
scope, still open through Phase 7) - see "Standing gaps" below before
scaling out.

`GET /healthz` is pure liveness (no dependency checks). `GET /readyz`
checks Redis (fatal, 503 on failure - ADR-0062) and Postgres
(non-fatal, reported only) and, since Phase 8, returns this instance's
own `region` (`INTRADAY_REGION`, ADR-0072) - useful for confirming a
gateway/DNS misroute didn't send wrong-region traffic here.

## 1. Redis is down (or `dataFreshness.status: "degraded"` is showing up)

**Confirm it's real, not a blip**: `curl :8200/metrics | grep intraday_redis_up`
(Phase 7's `RedisHeartbeatService`, ticks every 15s) - `0` means the
*last* heartbeat failed; check the timestamp implicitly via how recently
you scraped, since the gauge itself carries no timestamp of its own.
`curl :8200/readyz` gives you the freshest possible read (it pings Redis
synchronously, not on the 15s cadence) plus an HTTP status code (`503`
means down right now).

**What clients see while this is happening** - this is not a hard
failure, by design (§6.1):
- `agentLiveState`/`GET /v1/intraday/queues/:id/live` responses still
  return data, with `dataFreshness: { status: "degraded", lastKnownUpdateAt: ... }`
  - agent falls back to the most recent `AdherenceEvent` row (Phase 4),
  queue falls back to the most recent `queue_metrics_snapshot` row
  (Phase 7). If a queue/employee has *no* Postgres history either, the
  response is honestly all-`null` fields with `dataFreshness.status`
  still `"degraded"` - not a 500, not a lie that it's live.
- Every write path (`writeAgentLiveState`/`writeQueueLiveState`/the
  ingestion idempotency lock) throws `IntradayRedisUnavailableError` -
  ingestion returns `503` (the ACD/CCaaS system is expected to retry;
  §4.2), and any durable consumer whose `handlePayload` propagates that
  error `nak()`s for redelivery (not silently dropped - see §2 below for
  what that looks like in `intraday_nats_consumer_lag`).

**Recovery**: nothing to do manually - the next successful heartbeat
tick flips `intraday_redis_up` back to `1` and logs
`"Redis heartbeat recovered (Nms)"`; `/readyz` returns `200` again
immediately once Redis actually answers a ping, independent of the
15s cadence. Every consumer's own retry/nak loop naturally drains
whatever backed up while Redis was down (see §2).

## 2. NATS consumer lag / a stuck or poison message

`curl :8200/metrics | grep intraday_nats_consumer_lag` -
`NatsConsumerLagMonitorService` (Phase 7, every 30s) reports
`num_pending` per durable consumer (`intraday-agent-state-changed`,
`intraday-adherence-calculator`, `intraday-schedule-published`,
`intraday-assignment-changed`, `intraday-queue-metrics-updated`,
`intraday-queue-metrics-snapshot`).

- **A lag spike that drains within roughly a minute of a burst ending is
  expected, not a bug** - every durable consumer processes **strictly
  sequentially** (`DurableJetStreamConsumer.run()`'s own doc comment:
  "one message fully handled - acked or nak'd - before the next is
  pulled"), a deliberate trade of throughput for per-employee ordering
  (ADR-0063). `docs/module-05-phase-7-load-test-results.md` has one real
  measured data point: ~92,800 pending on `intraday-adherence-calculator`
  immediately after a 100k-event burst, fully drained inside ~30-60s.
- **A lag that does not drain** means the consumer loop itself has
  stalled - check this instance's own logs for
  `"consumer loop exited unexpectedly"` (`DurableJetStreamConsumer.onModuleInit`'s
  own catch) or a sustained string of
  `"Failed to process message on <subject> (seq N), nak'ing for redelivery"`
  warnings (the same message repeatedly nak'ing and being redelivered,
  never succeeding - check what's actually failing inside that
  consumer's `handlePayload`, e.g. a Postgres outage for
  `intraday-adherence-calculator`/`intraday-queue-metrics-snapshot`
  specifically, since those are the ones that write to Postgres).
- **A poison (unparseable JSON) message is `term()`'d, not redelivered
  forever** - logged as `"Poison message on <subject> (seq N) - terminating, not redelivering"`.
  **This message is not published to `AGNO_INTRADAY_DLQ`** - that
  stream has existed since Phase 1 but nothing in this service publishes
  to it yet (a real, standing gap, not fixed by any phase through 8 -
  see "Standing gaps" below). The only record of a terminated message
  today is that one log line; if you need the payload back, you need
  the original NATS-side seq number and JetStream's own retained history
  (24h retention on `AGNO_INTRADAY_EVENTS`, per
  `scripts/provision-nats-streams.ts`) - `nats stream get AGNO_INTRADAY_EVENTS <seq>`.

## 3. Alert pipeline — "why wasn't I notified about X"

```sql
SELECT id, alert_type, severity, status, dedup_group_id, created_at,
       last_triggered_at, escalated_at, acknowledged_by, acknowledged_at
FROM intraday.alert
WHERE tenant_id = '<tenant_id>' AND queue_id = '<queue_id>'
ORDER BY created_at DESC;
```
- `status = 'suppressed'` rows are the answer to "why wasn't I
  notified" (§2.2 rule 4 - suppressed is a real, queryable outcome, not
  a silent drop). Cross-reference against
  `SELECT * FROM intraday.alert_policy WHERE tenant_id = '<tenant_id>';`
  - either `suppression_rules` matched (a configured time-window rule)
  or the prior alert in the same `dedup_group_id` was acknowledged
  within `suppression_ack_window_minutes`.
- No `alert_policy` row for a tenant is expected, not broken -
  `AlertPolicyService` applies `DEFAULT_ALERT_POLICY` (5min dedup /
  15min suppression-ack / 15min escalation) in application code.
- A `warning` alert stuck open past its escalation threshold not
  flipping to `critical` means `AlertEscalationSchedulerService`
  (`@Cron('*/5 * * * *')`) isn't ticking - check for
  `"Escalation tick failed"` in this instance's logs (it uses
  `MIGRATOR_PG_POOL`, so a Postgres credential/connectivity issue there
  specifically, not the app's own `agno_intraday_app` role, is the first
  thing to check).

## 4. Reallocation — checking or manually approving a suggestion

```sql
SELECT id, triggered_by, from_queue_id, to_queue_id, affected_employee_ids,
       status, ai_rationale, created_at, executed_at
FROM intraday.reallocation_action
WHERE tenant_id = '<tenant_id>' AND status = 'suggested'
ORDER BY created_at DESC;
```
- `POST /v1/intraday/reallocations/<id>/approve` (with `X-Tenant-Id`) is
  the only supported way to act on a `suggested` row - it transitions
  `suggested → approved → executed` in one call (no separate "execute"
  step exists anywhere in the API - ADR-0070) and immediately moves each
  affected employee's `AgentLiveState.queueId` in Redis. There is no
  `rejectReallocation` - a suggestion you don't want just stays
  `suggested` forever (or gets naturally superseded once its repeat-guard
  window passes and a fresh suggestion for the same pair is created).
- `INTRADAY_REGION` has nothing to do with this;
  `INTRADAY_REALLOCATION_AUTO_EXECUTE_ENABLED` does - if it's `true`,
  suggestions never reach `suggested` at all, they go straight to
  `auto_executed`. Check this env var first if reallocations seem to be
  "approving themselves."

## 5. Partition / retention maintenance

- `adherence_event` (Phase 3, `AdherencePartitionSchedulerService`,
  daily at 01:00): creates the next 2 days' partitions, drops anything
  older than 95 days. If partitions stop appearing, writes will start
  failing with a Postgres "no partition of relation found for row" error
  (no `DEFAULT` partition exists, on purpose) - check for
  `"Partition maintenance tick failed"` in logs.
- `queue_metrics_snapshot` (Phase 7,
  `QueueMetricsSnapshotRetentionSchedulerService`, daily at 02:00):
  deletes rows older than 7 days. This table is degraded-fallback
  display data only (not partitioned, not analytics) - if this scheduler
  stops, the table just grows slowly; it does not affect correctness the
  way a stalled `adherence_event` partition job does.
- Both use `MIGRATOR_PG_POOL` (`agno_migrator` credentials) specifically
  because they're cross-tenant jobs - RLS's `ENABLE`-not-`FORCE` posture
  means the app's own `agno_intraday_app` role would only ever see one
  tenant's rows per connection, never all of them in one sweep.

## 6. Migration rollback

Every migration in `src/database/migrations/` has a real `down()`
(`DROP TABLE ...`) - `npm run migration:revert` undoes the most
recently applied one. All eight migrations are additive-only (new
tables/columns, never a destructive change to an earlier phase's
schema), so reverting any one of them is safe in isolation and doesn't
cascade into an earlier phase's own tables.

## Standing gaps this runbook does not paper over

**Single-instance PubSub, no consumer partitioning** - the in-process
`graphql-subscriptions` `PubSub` (ADR-0068) and this service's own
durable-consumer-per-process model mean running more than one instance
today does not give you working horizontal scale for subscriptions or
event ordering guarantees - it gives you N independent instances each
racing to consume the same JetStream messages. Deferred since Phase 4,
still open through Phase 8 - a real architecture change (consumer
partitioning + a distributed PubSub backend), not something this
runbook or any config flag works around.

**No `AGNO_INTRADAY_DLQ` publish** (§2 above) - a poison message is
logged and dropped, never routed to the dead-letter stream provisioned
for it since Phase 1. Pre-existing since Phase 1, never closed.

**No metric for the `queueLiveStateUpdated` push-latency SLO** (ADR-0072)
- validated only by periodically re-running `scripts/load-test.ts`
(Phase 7), not continuously monitored or alertable.

**No real tenant/actor authentication** - `X-Tenant-Id`/`X-Actor-Id` are
trusted as-is (header-trust placeholder, ADR-0068/0069), the same class
of gap this platform closed once (root app, ADR-0014 → ADR-0049) and has
left open in scheduling-service and this service alike. Anyone who can
reach this service's port can claim any tenant or any actor identity.

**No cross-region aggregation service** (ADR-0072) - designed, not
built; a tenant with data split across regions has no single
consolidated dashboard view today.

See each phase's own production readiness checklist
(`docs/module-05-phase-{1..8}-production-readiness-checklist.md`) for
the complete, phase-by-phase categorized list this summary draws from.
