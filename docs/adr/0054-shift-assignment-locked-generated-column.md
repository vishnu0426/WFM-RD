# ADR-0054: `ShiftAssignment.locked` is a Postgres `GENERATED ALWAYS` column, not an application-set flag

## Context
The module prompt's §2.2 rule 1 is explicit and non-negotiable: any assignment
with `assignment_source != auto_generated` must be treated as fixed input by
the solver on every re-optimization, "implemented as an explicit pre-solve
step that partitions the assignment set into 'fixed' and 'solvable' before the
model is even built, not as a post-hoc filter that could be forgotten in one
code path." `locked` is the column the pre-solve partition (Phase 5) will
filter on. If `locked` is an ordinary application-set boolean, it is possible
— by a future bug in one write path (e.g. a bulk-import or swap-acceptance
endpoint added in a later module) — to set `assignment_source: manual_override`
without also setting `locked: true`, silently reopening a human's override to
the solver.

## Decision
`locked` is declared `boolean GENERATED ALWAYS AS (assignment_source <>
'auto_generated') STORED`. No code path can write `locked` directly (Postgres
rejects an `INSERT`/`UPDATE` that targets a generated column); it is derived
by the database from `assignment_source` on every write, unconditionally. This
moves rule 1's invariant from "something every write path must remember to
uphold" to "something the schema makes structurally impossible to violate,"
the same category of defense-in-depth ADR-0002's RLS policies and ADR-0053's
`DEFAULT`-partition-less bootstrap already apply elsewhere in this platform.

## Consequences
- The Phase 5 pre-solve partition step queries `WHERE locked = true` /
  `WHERE locked = false` directly — it never needs to re-derive lock status
  from `assignment_source` itself, and cannot be fooled by a row where the two
  disagree, because that state is unreachable.
- `GENERATED ALWAYS ... STORED` columns are indexable like any other column;
  `ix_shift_assignments_tenant_schedule_locked` (tenant_id, schedule_id,
  locked) exists from this migration onward so Phase 5's partition query has
  an index to use rather than a sequential scan once schedules are large.
- SQLAlchemy's `db/models.py` mirrors this via `mapped_column(Boolean,
  Computed("assignment_source <> 'auto_generated'", persisted=True),
  nullable=False)` — `Computed(...)` tells the ORM to omit `locked` from
  every `INSERT`/`UPDATE` it emits, not just document that the DB would
  reject one. Getting this wrong is not theoretical: Phase 2's first attempt
  at persisting a `ShiftAssignment` mapped `locked` as a plain
  `Mapped[bool]` with a Python-side `default=False`, which made SQLAlchemy
  include it in the `INSERT` anyway and fail with
  `asyncpg.exceptions.GeneratedAlwaysError` against the real migrated
  schema — caught by actually inserting a row, not by code review of the
  migration SQL alone. The generated-column behavior remains authoritative
  in the migration SQL (ADR-0016's "ORM defines shape, migration SQL is the
  real DDL" split); `Computed(...)` here is the ORM accurately describing
  that authority, not duplicating it.
