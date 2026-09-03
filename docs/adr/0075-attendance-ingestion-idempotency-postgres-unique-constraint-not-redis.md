# ADR-0075: Badge/biometric clock-event idempotency is a Postgres unique constraint, not a Redis lock

## Context
§3.2 requires `POST .../clock-events` to be idempotent per device-provided
event id, the same requirement Module 05's `POST .../activity-events`
faced in its own Phase 1. That phase's answer (ADR-0047's idiom, its own
copy) was a Redis `SET...EX...NX` lock - deliberately fast, TTL-bounded,
and fail-closed (ADR-0062), justified there by Module 05's Redis-as-system-
of-record posture and sub-second-tempo ingestion volume.

Module 06 is explicitly framed differently (§0, §0.5): "lower engineering
risk... standard CRUD... not compute-heavy or high-throughput," and its own
Phase 1 design doc deliberately deferred bringing in Redis at all until
Phase 4's BullMQ approval-chain queue. Copying Module 05's Redis-lock
idiom here would mean introducing Redis a full phase early, for a write
path (one badge tap per employee, a few times a day, not a sub-second ACD
stream) that does not share Module 05's throughput justification.

## Decision
`attendance_ingestion_event` (Phase 2 migration
`1700000700000-AttendanceIngestionEventSchema.ts`): a durable table with a
`UNIQUE (tenant_id, source, source_event_id)` constraint, and a real
`attendance_record_id` foreign key into `attendance_leave.attendance_record`
(both tables are owned by this same migration/schema, so ADR-0052/0073's
"no FK across schemas" discipline doesn't apply - a real FK is strictly
better here, catching an application bug that writes a ledger row for a
record that doesn't exist). `AttendanceIngestionService` writes the
`AttendanceRecord` (insert for `clock_in`, update for `clock_out`) and this
ledger row **in one transaction**: a unique-violation on the ledger insert
(Postgres error `23505`) rolls the whole transaction back and *is* the
duplicate-detection signal - there is no separate pre-check-then-write step
to race under concurrency, and no window where the two writes could
diverge.

**Revision note**: the first cut of this design inserted the ledger row
*before* the `AttendanceRecord` write, on the theory that the ledger insert
should be the very first thing that happens (mirroring intraday-service's
"acquire the lock first" Redis shape) - with a manual "delete the ledger
row to compensate" step if the subsequent `AttendanceRecord` write failed.
That design does not typecheck against its own schema: the ledger row's FK
requires the `AttendanceRecord` it points at to already exist, so inserting
the ledger row first is a guaranteed FK violation, not an edge case. This
was caught by this phase's real-Postgres verification (a live `INSERT`
failing with `violates foreign key constraint`), not by unit tests against
mocked repositories - exactly the class of bug mocked-repository tests
structurally cannot catch, and the reason this phase's own production
readiness checklist insists on real-Postgres verification as a distinct,
named line item. The single-transaction design documented above is the
fix, and is simpler than the original, not just more correct: Postgres's
own transaction rollback is the compensating action, so no manual "delete
on failure" code exists in this service at all.

## Consequences
- No `REDIS_URL` or any Redis client exists anywhere in this service
  through Phase 2, matching Phase 1's design doc's explicit assumption 3 -
  Redis is introduced exactly once, in Phase 4, for BullMQ, and for no
  other purpose before then.
- Unlike Module 05's TTL-bounded lock, this ledger row is durable and
  never expires - a badge event replayed a year later is still recognized
  as a duplicate. This is a genuine, deliberate difference in guarantee,
  appropriate to attendance/payroll-adjacent data (§0's compliance framing)
  where "eventually stop deduplicating" is not an acceptable property, and
  inappropriate to copy back onto Module 05's ACD event stream (a
  live-state signal with no such retention requirement) if anyone is
  tempted to.
- `agno_attendance_leave_app` needs no `DELETE` (or `UPDATE`) grant on this
  table at all - Phase 1's "no DELETE anywhere in this schema" grant
  posture holds for this table unchanged, not an exception to it.
- Every write in this service must go through `withTenantConnection`
  (`src/database/with-tenant-connection.ts`, own copy of
  intraday-service's helper) - a plain `@InjectRepository` bypasses the
  per-request `app.current_tenant_id` GUC that RLS depends on, which is the
  *other* bug this phase's real-Postgres verification caught (every insert
  silently rejected by the tenant-isolation policy) before the FK issue
  above. Both bugs together are why this ADR insists real-Postgres
  verification is a named checklist item, not an optional nicety.
- This transactional-ledger-plus-domain-write pattern is available as
  precedent for Phase 3's `requestLeave` submission path or any future
  idempotent-mutation need in this service, the same way ADR-0047's Redis
  lock became this platform's general idempotency idiom for services that
  already have Redis - a future phase should default to this shape unless
  it has a specific reason (sub-second tempo, TTL expiry semantics) to
  reach for Redis instead.
