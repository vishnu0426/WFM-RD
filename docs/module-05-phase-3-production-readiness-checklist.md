# Module 05 Phase 3 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases (§0.5),
matching Phase 1/2's own format and honesty bar.

## Delivered in this phase (application code)

- [x] `intraday` Postgres schema + `agno_intraday_app` role (ADR-0066),
      additive to `scripts/init-roles.sql`, following ADR-0052's exact
      shared-database/new-schema/new-role pattern.
- [x] `intraday.adherence_event`: `PARTITION BY RANGE ("timestamp")` daily,
      composite PK `(id, "timestamp")`, no `DEFAULT` partition (fail-closed,
      ADR-0005's precedent), tenant-first B-tree index, and this platform's
      first BRIN index — all via one real migration
      (`1700000200000-InitialAdherenceSchema.ts`), not `synchronize`.
- [x] RLS on `adherence_event` and both rollup tables, reusing Module 01's
      exact `app.current_tenant_id` GUC convention (ADR-0002) unchanged.
- [x] Append-only grant enforcement on `adherence_event`
      (`REVOKE UPDATE, DELETE ... FROM agno_intraday_app`) — same posture
      as `core.audit_log`.
- [x] `intraday.adherence_hourly_rollup`/`adherence_daily_rollup`, keyed
      `(tenant_id, employee_id, bucket_start)`, maintained by
      `AdherenceRollupSchedulerService`'s hourly incremental upsert — the
      §3.4 pre-aggregation strategy standing up from day one, not
      retrofitted once raw-partition query performance becomes a problem.
- [x] `AdherencePartitionSchedulerService`: real, automated daily partition
      creation (2-day lookahead) and retention-based drop (95-day window) —
      the automated job §3.4 explicitly asks for, closing the exact gap
      `audit_log`/`forecast_data_points` both left to `pg_partman`.
- [x] `AdherenceCalculatorConsumerService`: a second, independent durable
      JetStream consumer on `agent.state_changed`, race-free with
      `AgentStateChangedConsumerService` by construction (ADR-0067's
      self-referential `from_activity` lookup) — proven end-to-end against
      real Redis/NATS/Postgres, not just unit-tested.
- [x] A deliberately narrow, documented exception to "the runtime app role
      never does DDL/cross-tenant queries": the two scheduler jobs use a
      separate migrator-credentialed pool
      (`database/migrator-pool.provider.ts`), every other code path in
      this service (ingestion, both Phase 2 consumer families, this
      phase's own adherence calculator) continues to use `agno_intraday_app`
      exclusively.
- [x] `/readyz` Postgres check, reported-but-non-fatal by design (contrast
      with Redis's fatal posture, ADR-0062) — a deliberate, documented
      asymmetry, not an inconsistency.
- [x] Unit test suite (26 new tests across 6 spec files: the coarse
      adherence rule and deviation-seconds computation, partition
      name/date arithmetic, the consumer's `handlePayload` logic with a
      mocked tenant-scoped transaction, both scheduler services including
      their re-entrancy guards) — no live infra required to run `npm test`.
- [x] Two ADRs (0066 storage engineering, 0067 calculation semantics)
      written now, not deferred, per §7's explicit ask for "the
      ClickHouse→Postgres mitigation" ADR by name.
- [x] Verified end-to-end against a real local Postgres, Redis, and NATS:
      migration applied cleanly, RLS/BRIN/partition-bootstrap/grants
      confirmed via `psql` introspection, a real signed activity webhook
      produced both a Redis `AgentLiveState` write (Phase 2, unchanged)
      *and* a Postgres `adherence_event` row (this phase) off the same
      NATS message, independently. TypeORM's single-row insert against the
      composite-PK partitioned table (assumption 4) worked without the
      SQLAlchemy-analogous issue ADR-0056 flagged as unconfirmed for this
      ORM — resolved empirically, not left as an open question.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Any live-read API for `AdherenceEvent`/the rollup tables.** Nothing
      in this repo queries this data back yet — GraphQL/REST is Phase 4.
- [ ] **A richer, activity-code-based adherence taxonomy.** Blocked on
      scheduling-service growing an activity-code data model on
      `ShiftAssignment` — flagged in ADR-0064's own consequences section,
      not solved here. `deviation_seconds`/adherence today is the honest
      ceiling of the coarse `on_shift`/`null` signal, not a permanent
      design choice (ADR-0067).
- [ ] **Org-unit-level rollups.** No upstream payload in this platform's
      intraday pipeline carries `org_unit_id` — rollups are keyed by
      `employee_id` instead (ADR-0066's consequences).
- [ ] **Cold-storage export of dropped partitions before they're dropped**
      (§3.4's "moved to cheaper storage"). Same accepted-gap class as
      `pg_partman` for `audit_log`/`forecast_data_points` — a third
      instance of the same, named gap, not silently absent.
- [ ] **Horizontal-scaling-safe consumer partitioning for
      `AdherenceCalculatorConsumerService`.** Assumes a single running
      `intraday-service` instance, same scope boundary
      `AgentStateChangedConsumerService` already has (ADR-0063/ADR-0065) —
      Phase 7.
- [ ] **The 100k+-agent release-gate load test, chaos/game-day exercises.**
      This phase gives the load test something real to exercise (an actual
      write pipeline into a partitioned, indexed, rolled-up store) but does
      not run it — Phase 7, same as every prior phase's own checklist.
- [ ] **Terraform/Vault, rate limiting, penetration testing, SAST/SBOM.**
      Same explicit non-goals already stated platform-wide for every
      module's early phases — not re-litigated per phase.
