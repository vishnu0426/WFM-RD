# ADR-0003: `varchar` + `CHECK` instead of native Postgres `ENUM`

## Context
§2.1 specifies several enum-typed columns (`tenant.tier`, `tenant.status`,
`user.status`, `permission.action`, `policy.policy_type`, `audit_log.actor_type`,
`notification_preference.channel`). Native Postgres `ENUM` types are attractive
(compact storage, DB-level validation) but `ALTER TYPE ... ADD VALUE` cannot run
inside the same transaction that later uses the new value (pre-PG12 it couldn't run
in a transaction block at all; PG12+ allows it standalone but still not
combined-with-use in one transaction), and dropping/renaming a value has no direct
support at all short of rebuilding the type.

## Decision
Use `varchar` columns with a `CHECK (col IN (...))` constraint. TypeScript-side, each
column is still backed by a real TS `enum` for compile-time safety in application
code — only the Postgres representation differs from a native `CREATE TYPE ... AS
ENUM`.

## Consequences
- Adding a new `policy_type` for a new vertical (§2.1 rule 4's whole reason for
  `Policy.definition` being JSONB) is a normal, transactional
  `ALTER TABLE ... DROP CONSTRAINT ...; ALTER TABLE ... ADD CONSTRAINT ... CHECK
  (...)` migration — no special-cased "outside a transaction" step, no downtime
  choreography.
- Slightly larger on-disk footprint than a native enum (varchar vs. 4-byte oid).
  Irrelevant at this table size; flagged here only so it isn't rediscovered later as
  a mystery.
- Query planner statistics on `CHECK`-constrained `varchar` are the same as any other
  `varchar` column (histogram-based), not the specialized enum comparison Postgres
  uses for native enums. Not a concern for the cardinalities here (single-digit to
  low-double-digit distinct values per column).
