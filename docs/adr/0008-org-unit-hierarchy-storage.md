# ADR-0008: `OrgUnit` hierarchy storage - materialized path (`ltree`), not a bare recursive CTE

## Context
§2.2 rule 4 requires `OrgUnit` to support arbitrary depth "with no schema change
required," and explicitly calls out choosing between a recursive CTE and a
materialized path/`ltree` column as a trade-off needing an ADR, not a silent pick.
The self-referencing `parent_org_unit_id` FK already supports arbitrary depth at the
schema level either way - the decision is about how subtree reads are served at
scale (§0.5: 10M+ employees platform-wide, and
`EmployeeService.GetSchedulableEmployees` - Scheduling's hot-path call, p99 < 100ms
- filters by org-unit subtree).

## Options considered
1. **Bare recursive CTE** (`WITH RECURSIVE ... parent_org_unit_id`) on every subtree
   read. No extra column, no write-time cost. But cost scales with subtree depth and
   fan-out at read time, on every call, on the hot path.
2. **Closure table** (a separate `org_unit_ancestor` join row per ancestor/descendant
   pair). O(1) subtree reads via an indexed join, but O(depth) row writes per
   reparent *and* a second table whose own consistency has to be maintained -
   doesn't reduce complexity versus option 3, just moves it.
3. **Materialized path via `ltree`** (chosen). One `path ltree` column, GiST-indexed;
   subtree reads become `path <@ :rootPath` - a single indexed lookup, no recursion,
   no join table. Postgres's native `ltree` extension (trusted since PG13, no
   superuser needed) handles containment/ancestor operators natively.

## Decision
`OrgUnit.path` (not mapped in the TypeORM entity - see its doc comment), maintained
entirely by triggers in the Phase 1 migration:
- `org.fn_org_unit_set_path` (BEFORE INSERT) computes the new row's path from its
  parent's current path.
- `org.fn_org_unit_recompute_path_on_update` (BEFORE UPDATE) recomputes this row's
  own path when `parent_org_unit_id` changes, and rejects reparenting under self or
  a descendant.
- `org.fn_org_unit_cascade_path` (AFTER UPDATE) rewrites every descendant's path
  prefix in one statement when a reparent changes this row's path.

Point-in-time hierarchy reconstruction (`orgHierarchy(rootId, asOfDate)`, Phase 2)
does **not** use `path` - it walks `OrgUnitHistory.parentOrgUnitId` via a recursive
CTE instead (see ADR-0009). `path` only ever reflects the *current* tree; a
materialized path for historical trees would require rewriting past history rows
retroactively on every reparent, defeating the point of an immutable audit trail.

## Consequences
- Subtree reads (the hot path) are a single GiST-indexed containment query, not a
  recursive CTE - meets the §0.5 SLO discipline this module inherited.
- Reparenting is O(subtree size), not O(1): moving a large subtree rewrites every
  descendant's path. Accepted because org restructuring is rare relative to reads.
  A known, documented amplification exists on top of that: each rewritten
  descendant's own `AFTER UPDATE` trigger fires and issues its own (idempotent,
  ultimately no-op) cascade pass - see the trigger's own comment in the migration.
  If reorg volume ever becomes routine (e.g. a bulk-import-driven mass reparent),
  revisit this trade-off.
- `path` uses UUID labels with hyphens replaced by underscores (`ltree` labels
  don't allow hyphens) - purely a storage-format detail, invisible to callers who
  only ever query via `<@`/`@>`.
- Two hierarchy-read mechanisms now exist in the schema (`path` for current-state
  subtree reads, `OrgUnitHistory.parentOrgUnitId` recursive walk for as-of reads) -
  a deliberate split, not an oversight; see ADR-0009 for why they don't share one
  mechanism.
