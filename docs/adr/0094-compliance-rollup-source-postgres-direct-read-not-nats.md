# ADR-0094: the rollup job reads Module 05's Postgres rollup tables directly, not the NATS event stream

## Context
The source spec's architecture section (and its §3.3) describes Module 08
consuming "Module 05's Kafka adherence event stream" and a "ClickHouse
event stream" - both stale relative to Module 05's actual, already-overridden
design (ADR-0062/0063/0066/0072: Redis for live state, NATS JetStream as
the event backbone, Postgres/partitioned-BRIN-rollup as the durable store,
no Kafka or ClickHouse anywhere in this platform). §1 of this module's own
prompt flags this explicitly and requires an ADR choosing between two live
options rather than silently porting the stale assumption forward:

1. **Direct Postgres read** against Module 05's `adherence_event` and
   `adherence_hourly_rollup`/`adherence_daily_rollup` tables (ADR-0066), via
   a dedicated read connection - simpler, and consistent with this module's
   own "rollup jobs, not live queries" design (§0.5's reproducibility
   requirement: the same report requested twice for the same period must
   return the same numbers).
2. **NATS JetStream consumption** of `agno.intraday.agent.state_changed.v1`
   directly - lower latency for the 15-minute tick, but means this module
   would be computing its own aggregation from raw per-event state changes
   rather than reading an already-computed, already-tested rollup.

## Decision
**Direct Postgres read**, against Module 05's `adherence_hourly_rollup`/
`adherence_daily_rollup` tables specifically (not the raw `adherence_event`
partition set), via a dedicated read-only connection authenticated as
`agno_intraday_app` - the same role Module 05's own runtime process uses,
not a widened grant on `agno_compliance_app` (ADR-0093). Three reasons, in
order of weight:

1. **§0.5's reproducibility requirement is a correctness property, not a
   performance nice-to-have** (the module prompt's own words). A rollup job
   that re-derives its own aggregation from a stream of raw state-change
   events has to reproduce Module 05's exact windowing/edge-case semantics
   (ADR-0067's adherence-calculation-semantics ADR exists precisely because
   those semantics are non-trivial) or risk computing a *different* number
   than Module 05's own rollup for the same period - two sources of truth
   for "what was this employee's adherence in this window," exactly the
   drift risk §0.6 exists to prevent, just recreated on the metrics side
   instead of the policy side. Reading Module 05's own already-computed,
   already-tested rollup avoids re-deriving that logic a second time.
2. **The document's own "how to use this document" correction** already
   names "Module 05's Postgres rollup tables (Module 05 §3.4)" as the
   corrected reading of where this module's raw adherence data comes from -
   this ADR makes that correction the actual architecture, not just the
   doc-comment framing.
3. **A 15-minute rollup tick has no real latency pressure that only a
   streaming consumer could satisfy.** Module 05's own `adherence_hourly_rollup`
   is itself refreshed on a schedule (ADR-0066), not synchronously with
   every event; polling that table on this module's own 15-minute cron tick
   loses nothing NATS consumption would have bought, at a fraction of the
   operational complexity (no consumer group, no offset tracking, no
   at-least-once redelivery/dedup logic to build).

## Consequences
- This module's rollup job (Phase 3) is a `@nestjs/schedule` cron runner
  issuing `SELECT` queries against `intraday.adherence_hourly_rollup`/
  `intraday.adherence_daily_rollup` via the dedicated `agno_intraday_app`-
  authenticated connection (`INTRADAY_DB_*` env vars, declared in this
  phase's `.env.example` but not wired to anything yet), then upserting
  into this module's own `adherence_score`/`occupancy_record`/
  `shrinkage_record` tables using the unique keys this migration already
  defines (§2.2 rule 4's idempotency requirement).
- No NATS client, no `nats` package dependency, and no
  `agno.intraday.agent.state_changed.v1` subscription anywhere in this
  service - consistent with this module's own §1 table allowing (not
  requiring) NATS JetStream only "if the near-real-time consumption path is
  chosen," which it was not.
- If a future SLO genuinely needs sub-15-minute visibility into adherence
  data that polling Module 05's rollup tables cannot satisfy, that is a new
  requirement to revisit with its own ADR - not a reason to have guessed at
  NATS consumption speculatively now.
- Module 05 must keep `adherence_hourly_rollup`/`adherence_daily_rollup`
  queryable by `agno_intraday_app` at the granularity this module's rollup
  job needs; a breaking change to those tables' shape is cross-module
  breaking change for Module 08, the same discipline ADR-0066 already
  states for `ComplianceRule.definition`'s own downstream consumers.
