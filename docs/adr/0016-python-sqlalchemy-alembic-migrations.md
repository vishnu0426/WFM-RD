# ADR-0016: SQLAlchemy (async) for persistence + hand-written SQL Alembic migrations

## Context
Module 03 needs the Python equivalent of ADR-0001's decision: an ORM/query layer
tight enough for FastAPI's async request lifecycle, plus a migration mechanism
that can express Postgres features no ORM schema DSL covers natively — `CREATE
POLICY`, `GRANT`/`REVOKE`, `PARTITION BY RANGE`, `CHECK` constraints tied to enum
semantics. Same constraint set as Module 01, different language.

## Decision
`sqlalchemy[asyncio]` 2.0 + `asyncpg` for the runtime query layer (`app/db/models.py`
declares `Table`/`mapped_class` definitions as the Python-side source of truth for
column names/types, mirroring how `*.entity.ts` files serve that role in Module
01/02). `alembic` owns migration versioning and the `up`/`down` (`upgrade`/
`downgrade`) lifecycle, but migration bodies are hand-written SQL via `op.execute(...)`
— not `alembic revision --autogenerate`, for the same reason `synchronize: true`
and TypeORM's decorator-driven generation were rejected in ADR-0001: autogenerate
cannot express RLS, `GRANT`, or partitioning, and a migration tool that silently
can't express half of what a schema needs is worse than one that never tries.

## Consequences
- Two sources of truth to keep in sync by hand (SQLAlchemy models vs. migration
  SQL), exactly the same trade-off ADR-0001 accepted. Module 01's answer was a CI
  lint (`migration:lint`) diffing the two; Module 03 does not yet have an
  equivalent Python lint in this phase — flagged in the production readiness
  checklist as a gap to close before this schema sees real traffic, not silently
  assumed solved by copying the pattern's name without its enforcement.
- `alembic.ini`'s `sqlalchemy.url` is never used directly for connecting — the
  same `agno_migrator` credential Module 01/02 use for their migrations is reused
  here (`env.py` reads `DB_MIGRATION_*` env vars), preserving the two-role split's
  invariant that only the migrator role ever runs DDL.
- Downside accepted: no diff-based migration generation, same hand-authoring cost
  ADR-0001 already accepted for the Node side. This module inherits that cost
  rather than re-litigating it with a different tool (e.g. Django migrations,
  which has the same fundamental gap for RLS/partitioning DDL).
