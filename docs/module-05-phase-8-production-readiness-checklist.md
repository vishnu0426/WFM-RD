# Module 05 Phase 8 (Final) Production Readiness Checklist

This is Module 05's **final** phase - this checklist covers only what
Phase 8 itself delivered/didn't. For the complete picture across all
eight phases, see each phase's own checklist
(`docs/module-05-phase-{1..7}-production-readiness-checklist.md`) plus
the consolidated "Module-wide standing gaps" section at the bottom of
this one, which indexes (not re-derives) the real, still-open items
named across every prior phase.

## Delivered in this phase (application code + docs)

- [x] `INTRADAY_REGION` config value + `GET /readyz`'s new `region`
      field (`HealthController`) - this instance's own region identity,
      real and observable (not a fabricated multi-region capability) -
      proven end-to-end against a real booted service.
- [x] `observability/grafana-dashboard-module-05.json` - a real,
      auto-loaded Grafana dashboard covering every metric this service
      actually emits (ingestion/REST-snapshot SLO panels, Redis health,
      NATS consumer lag/publish latency, ingestion outcomes, process
      health), validated as structurally correct JSON. Includes an
      explicit, honest markdown panel noting the one stated SLO
      (`queueLiveStateUpdated` push latency) with no continuous metric,
      rather than a silently missing panel.
- [x] `observability/prometheus.yml` scrape entry for this service's
      own `/metrics` (port 8200), validated as structurally correct
      YAML matching the two existing entries' shape.
- [x] `docs/module-05-runbook.md` - real operational scenarios (Redis
      outage, NATS consumer lag/poison messages, alert/reallocation
      troubleshooting, partition/retention maintenance, migration
      rollback) with real SQL/metric snippets, matching
      `docs/module-04-runbook.md`'s own format and honesty bar.
- [x] ADR-0072 - the multi-region topology decision (independent
      per-region stacks, no key/subject schema change), the
      `INTRADAY_REGION` addition's actual scope (observability, not
      enforcement), and the explicitly-flagged missing
      subscription-latency metric.
- [x] `test/unit/health.controller.spec.ts` extended for the new
      `region` field and its default.

## Explicitly NOT done here (needs a different owner or never in this module's scope)

- [ ] **Actual multi-region infrastructure** (Redis Cluster/NATS
      Supercluster provisioning, DNS/GSLB tenant-to-region routing) -
      §9's own explicit non-goal for this entire module, a DevOps/Cloud
      deliverable start to finish, not begun here.
- [ ] **A canonical region-code enum for `Tenant.dataResidencyRegion`** -
      that entity belongs to Module 01, not this module's to constrain.
- [ ] **The cross-region aggregation service** - designed in ADR-0072,
      not built; no second region exists yet to build it against.
- [ ] **A Prometheus metric for the `queueLiveStateUpdated` push-latency
      SLO** - real but nontrivial (publish-timestamp propagation through
      the full NATS→consumer→PubSub→WS chain); validated only via
      periodic `scripts/load-test.ts` runs (Phase 7), not continuously
      monitored or alertable.

## Module-wide standing gaps (indexed from every prior phase's own checklist, not re-derived)

- [ ] **Single-instance PubSub, no consumer partitioning** - the
      in-process `graphql-subscriptions` backend (ADR-0068, Phase 4) and
      this service's own durable-consumer-per-process model mean running
      more than one instance today does not give working horizontal
      scale for subscriptions or ordering guarantees. Deferred at every
      phase since Phase 4 (Phase 5/6/7 checklists all name it), still
      open at the end of Phase 8.
- [ ] **No `AGNO_INTRADAY_DLQ` publish** - a poison message is logged
      and `term()`'d, never routed to the dead-letter stream provisioned
      since Phase 1 (Phase 7's checklist first named this explicitly;
      still open).
- [ ] **No real tenant/actor authentication** - `X-Tenant-Id`/
      `X-Actor-Id` are trusted as-is since Phase 4 (ADR-0068), the same
      class of gap this platform closed once (root app) and left open in
      scheduling-service and this service alike.
- [ ] **No `graphql-ws` connection-level tenant authentication** - a
      client can subscribe to any tenant/queue id it already knows
      (ADR-0068's own consequences, Phase 4, never closed).
- [ ] **The §0.5 SLOs proven only at burst scale, not sustained load** -
      Phase 7's load test validated a 15-second, 100k-employee burst;
      it does not prove the same numbers hold across hours of continuous
      traffic (Phase 7's own load test results doc names this
      explicitly).
- [ ] **Terraform/Vault, rate limiting, penetration testing, SAST/SBOM** -
      the same explicit non-goals stated platform-wide for every
      module's early phases, restated (not newly discovered) here.

## Summary: what Module 05 actually is, end to end

Redis (`AgentLiveState`/`QueueLiveState`, fail-visible, ADR-0062) + NATS
JetStream (durable, per-employee-ordered consumers, ADR-0063) +
partitioned Postgres (`AdherenceEvent`/rollups, ADR-0066) feeding a
GraphQL/REST live dashboard API (ADR-0068) with a real degraded-mode
contract for both agents and queues (Phase 4/7), a full dedup/
suppression/escalation alert pipeline (ADR-0069), a suggest-and-approve
(or feature-flagged auto-execute) reallocation flow (ADR-0070), proactive
Redis/NATS observability plus a real 100k-agent load test proving the
stated SLOs at burst scale (Phase 7), and an application-layer
multi-region design ready for whenever real regional infrastructure
exists to build against (ADR-0072). Eight phases, eleven ADRs
(0062-0072), one runbook, one dashboard - the standing gaps above are
the honest, named boundary of what this module does not yet claim to
solve.
