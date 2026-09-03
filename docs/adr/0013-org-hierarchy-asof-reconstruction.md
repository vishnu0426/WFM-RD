# ADR-0013: `orgHierarchy(rootId, asOfDate)` reconstructs past trees via an in-memory walk, not a recursive SQL CTE

## Context
§2.3/§3.1 require `orgHierarchy(rootId, asOfDate)` (GraphQL) and
`GET /v1/org-units/{id}/tree?as_of=<date>` (REST) to answer "show me the org chart
as of March 1st." ADR-0008 already established that the live table's `path` column
only reflects the *current* tree and deliberately isn't replicated into
`OrgUnitHistory` - so reconstructing a past tree has to walk `parentOrgUnitId`
somehow. The remaining choice is where that walk happens.

## Options considered
1. **Recursive SQL CTE** directly against `org.org_unit_history`, filtered to rows
   valid at `asOfDate`, recursing from `rootId` down through `parentOrgUnitId`. Pushes
   the traversal into Postgres, but needs a hand-written recursive query per call site
   (GraphQL resolver, REST controller) or a repository method wrapping raw SQL either
   way - and ADR-0007 already set a precedent in this codebase of avoiding recursive
   traversal at the query level when an application-layer walk is cheap enough.
2. **In-memory walk** (chosen): `OrgUnitHistoryRepository.findAllAsOf(asOf)` fetches
   every org unit's version valid at `asOf` for the tenant in one query (a single
   `WHERE valid_from <= :asOf AND (valid_to IS NULL OR valid_to > :asOf)` scan,
   indexed by `idx_org_unit_history_tenant_id_org_unit_id`), and
   `OrgHierarchyService.assembleTree` builds a `parentOrgUnitId -> children[]` map
   and walks it from `rootId` in JS.

## Decision
In-memory walk, mirroring ADR-0007's own reasoning for BPO tenant-hierarchy traversal
("recursive RLS predicates are a well-known performance and correctness hazard...
deliberately avoided here"). Org-unit counts per tenant are orders of magnitude below
the 10M-employee scale this module partitions for (ADR-0010) - a single tenant's
`org_unit_history` row count at any one point in time is bounded by its org-unit
count, not its employee count, so fetching "every org unit valid at `asOf`" in one
query and walking it in memory is cheap and avoids a second recursive-query
implementation living only in this one code path.

`OrgHierarchyService` is the single place this logic exists, shared by both the
GraphQL `orgHierarchy` query and the REST `GET /v1/org-units/{id}/tree` controller -
see its own doc comment.

## Consequences
- If a future tenant's org-unit count grows large enough that "fetch everything valid
  at `asOf`" stops being cheap, the fix is swapping `findAllAsOf` + the in-memory walk
  for a recursive CTE *inside `OrgHierarchyService` alone* - the GraphQL/REST call
  sites don't change, since they only depend on `getHierarchy(rootId, asOfDate)`'s
  return shape (`OrgUnitSnapshotType`), not how it's computed.
- `orgHierarchy` with no `asOfDate` (current tree) deliberately takes a *different*
  code path (`OrgUnitsRepository.findSubtree`, the ltree/GiST-indexed read from
  ADR-0008) rather than calling `findAllAsOf(now())` - the live `path` column exists
  specifically to make the current-tree read O(1) via the index, and routing it
  through the historical path would throw that away for no benefit.
- A request for a `rootId` that never existed, or existed but not at the given
  `asOfDate`, surfaces as `OrgUnitNotFoundError` (404 over REST, `NOT_FOUND` extension
  over GraphQL) - same not-found semantics as the live-tree path, not a distinct
  "no history" error, since from the caller's perspective both mean "nothing to show
  for that id right now."
