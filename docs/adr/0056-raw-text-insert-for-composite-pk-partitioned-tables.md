# ADR-0056: Raw `text()` `INSERT`, not ORM `add()`/Core `insert()`, for `shift_assignments` and `fairness_ledger`

## Context
Phase 3 found a genuine SQLAlchemy/asyncpg failure mode while writing
`FairnessLedger` rows at publish time and, on closer inspection, an
identical *latent* bug already sitting in Phase 2's `ShiftAssignment`
persistence (`job_service.create_job`) — it had simply never been exercised,
because no Phase 2 test happened to produce two or more `ShiftAssignment`
rows in a single job. Phase 3's cross-run fairness test (three shifts in one
job) was the first scenario that did, and it failed identically.

Both tables share the same shape: a client-generated composite primary key
`(id, <a timestamptz column that's also the partition key>)`, on a
`PARTITION BY RANGE` table (ADR-0053). Inserting through the ORM
(`session.add(...)`) or through SQLAlchemy Core's `insert()` — even with a
single row, even with `execution_options` left at their defaults — hits:

```
sqlalchemy.exc.InvalidRequestError: Can't match sentinel values in result
set to parameter sets; key (UUID(...), datetime.datetime(...)) was not found.
```

This is SQLAlchemy 2.0's `insertmanyvalues` optimization: for Postgres, it
appends `RETURNING` to `INSERT` statements and uses a "sentinel" (by default,
the primary key) to map returned rows back to the Python objects that
produced them — needed when the DB, not the client, generates part of the
row. Neither table needs that: every column, including both halves of the
composite key, is already known before the `INSERT` is issued.

Multiple angles were tried before landing on the fix, each ruled out in
turn: batching multiple rows into one `execute()` call vs. one row per call
(no difference — even a lone row fails); Core `insert()` vs. ORM `add()` (no
difference — same code path); a hypothesis about naive-vs-aware datetimes
round-tripping through a prior `SELECT` in the same transaction (checked
directly — values came back correctly timezone-aware). The failure
reproduces reliably through the real FastAPI/`TestClient` request path but
not through an equivalent bare `asyncio.run(...)` script hitting the same
tables via the same session helpers — suggesting something specific to that
execution context (event loop handling, connection reuse, or statement-cache
state under `TestClient`) is a contributing factor, not just the table
shape alone. The exact trigger was not fully pinned down; see the
Consequences section for why that's an acceptable place to stop.

## Decision
Both `job_service.create_job`'s `ShiftAssignment` writes and
`schedule_service.publish_schedule`'s `FairnessLedger` writes use a raw
parameterized `sqlalchemy.text()` `INSERT`, one `execute()` call per row,
instead of `session.add(...)` or Core `insert(...)`. `text()` statements are
not parsed by SQLAlchemy's statement compiler, so they never become
`insertmanyvalues`-eligible in the first place — this sidesteps the failure
mode regardless of its precise root cause, rather than chasing an
unconfirmed theory further.

`ShiftAssignment.locked` (`GENERATED ALWAYS`, ADR-0054) is omitted from the
raw `INSERT`'s column list, same as it always was — Postgres computes it
from `assignment_source` on every write regardless of which API inserts
the row.

## Consequences
- **Any future write path that inserts multiple rows into a table shaped
  like this — a client-generated composite `(id, <partition-key
  timestamptz>)` primary key on a `PARTITION BY RANGE` table — should use
  this same raw-`text()` pattern from the start**, not rediscover the
  failure. This applies directly to Phase 5's locked-assignment writes and
  Phase 7's decomposition-driven bulk writes, both of which write
  `shift_assignments` at multi-row scale.
- The root cause remains only partially diagnosed. If a future SQLAlchemy
  upgrade changes `insertmanyvalues` behavior, this workaround may become
  unnecessary — but it is also unlikely to become *wrong* (raw `text()`
  inserts are correct regardless), so there is no urgency to revisit it
  without a specific reason to.
- Slight readability/maintenance cost: the column list and `VALUES`
  placeholders in `job_service.py`/`schedule_service.py` are now spelled out
  by hand rather than derived from the ORM model, and will silently drift
  out of sync with `app/db/models.py`/the migration if a column is ever
  added to either table without updating both raw `INSERT` strings too —
  flagged in the production readiness checklist as a real, not
  hypothetical, maintenance gap this workaround introduces.
- Reads (`select(ShiftAssignment)`, `select(FairnessLedger)`) are unaffected
  and continue to use the normal ORM query path — this issue is specific to
  `INSERT ... RETURNING`, not to querying these tables.
