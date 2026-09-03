# Module 12 Phase 4 Design Doc — Integration Hub: Field Authority Policy + Conflict Resolution

**Status:** Approved for implementation
**Owner:** Integration Hub pod (Module 12).
**Scope:** Per §7 — "§5b in full for batch connectors, including the admin-facing conflict review workflow, before adding more batch connector types." Concretely: `FieldAuthorityPoliciesService` + GraphQL `createFieldAuthorityPolicy`/`fieldAuthorityPolicies` (§3.1), real conflict detection wired into `WorkdayAdapter` between dry-run and commit (§2.2 rule 3a's ordering), and making flagged conflicts genuinely queryable via `syncJobHistory` (already built, Phase 3) rather than a buried, opaque error string.

## Problem

Two real design questions, both resolved by looking at what Module 02 actually exposes rather than assuming a shape:

1. **Where does "Agno WFM's current value" for a field come from?** No employee-by-`employeeNumber` read endpoint exists anywhere in Module 02 (verified by reading its GraphQL resolver and filter DTOs directly, not assumed). Resolved in ADR-0139: reuse the `{old, new}` diff Module 02's own bulk-import dry-run already computes for every updated field, rather than inventing a new Module 02 read path - the same dry-run §2.2 rule 3a already requires. Real consequence: Module 02's own diff logic deliberately excludes `hireDate`/`userId` from that diff, so this module structurally cannot detect a conflict on those two fields yet - disclosed, not silently assumed away.
2. **What does "the admin-facing conflict review workflow" mean for a phase whose own module prompt puts the actual dashboard in Phase 8?** Read narrowly: Phase 4's job is making conflicts genuinely *queryable and actionable* in the data layer (§5b: "not a buried error_details blob") - a well-structured, well-known JSON shape inside `SyncJob.errorDetails.fieldAuthorityConflicts`, surfaced via the `syncJobHistory` query Phase 3 already built. The actual dashboard UI screen is Phase 8's own named scope ("Connector health dashboard").

## Decision

**`FieldAuthorityPoliciesService.upsert`** (`src/connectors/field-authority-policies.service.ts`) - keyed by the `(connector_id, field_name)` unique constraint from Phase 1, the same upsert-for-parity decision `FieldMappingsService` made (§3.1 names `createFieldAuthorityPolicy` with no separate update mutation - without upsert semantics, an admin who misconfigures `conflict_action` would have no way to fix it). Rejects `connector_type: acd` at the point of write (§2.2 rule 5), loading the connector first specifically to check this - not deferred to a later validation pass.

**`detectFieldAuthorityConflicts`** (`src/sync/batch/conflict-detection.ts`, pure function, ADR-0139) - given a dry-run's `BulkImportJobResult` and the connector's `FieldAuthorityPolicy` rows, produces: every detected conflict (for observability, all three `conflict_action` values), the set of employee numbers to exclude entirely from commit (`reject_sync`), and a per-employee map of fields to revert to their Agno value before commit (`flag_for_review`). `overwrite` conflicts are recorded but otherwise unobstructed - an explicit admin override of Agno's own authority.

**`WorkdayAdapter` wiring**: conflict detection runs *between* the dry-run and the commit call, never after - `flag_for_review` fields are reverted to their current Agno value in the record about to be committed (so the rest of that employee's real, non-conflicting changes still land in the same sync), `reject_sync` employees are dropped from the commit batch entirely (not just the conflicting field). The outcome's `errorDetails.fieldAuthorityConflicts` carries every conflict's `{employeeNumber, fieldName, agnoValue, incomingValue, conflictAction}` - queryable via `syncJobHistory`, not opaque.

## Verification

**Unit** (`test/unit/sync/conflict-detection.spec.ts`, 9 tests): each `conflict_action` in isolation, multiple conflicting fields on one employee, multiple employees, `external_system`-authoritative fields never conflicting, unconfigured fields never conflicting, `creates` never conflicting, and the null/empty dry-run-result edge case.

**Real end-to-end, real Postgres + real Vault + real fake-Workday server + REAL Module 02** (`test/integration/field-authority-conflict.spec.ts`): establishes two real baseline employees via an initial sync (no policies yet), then re-syncs with both a `costCenter` change (a real conflict, `agno_wfm`-authoritative) and an `employmentType` change (a real, non-conflicting change) on the same records. Proves, by querying `org.employees` directly (not trusting this module's own reported outcome):
- **`flag_for_review`**: `costCenter` genuinely stays at its pre-sync Agno value, while `employmentType`'s real change genuinely commits on the *same* sync run.
- **`reject_sync`**: switching the policy and re-syncing with both fields changed again, the *entire* record is excluded - neither `costCenter` nor the real `employmentType` change commits.
- **§6's explicit test**: `connector_type: acd` rejects both `createFieldAuthorityPolicy` (`FieldAuthorityPolicyNotApplicableError`) and a `FieldMapping.authority` value (`FieldMappingAuthorityNotApplicableError`, Phase 3's own guard, re-verified here) - while a mapping with no `authority` at all remains valid for an `acd` connector, confirming the field is nullable, not forbidden.

**Live HTTP pass against the actually-running app**: `createFieldAuthorityPolicy`/`fieldAuthorityPolicies` exercised over real GraphQL, including the `acd` rejection - no new bugs found this time (Phase 2's `HttpMetricsInterceptor`/`DomainErrorFilter` GraphQL fixes already cover this new resolver, confirming those were genuinely general fixes, not narrowly patched to Phase 2's own surface).

**Full suite**: 42 unit tests (up from 33) + 27 integration tests (up from 25), `typecheck`/`lint` both clean.

## Blast radius

- New code within `integration-hub-service/`: `src/connectors/field-authority-policies.service.ts`, `src/connectors/graphql/field-authority-policy.resolver.ts`, `src/sync/batch/conflict-detection.ts`. One new ADR (0139) and this doc.
- `WorkdayAdapter` modified (Phase 3 code) to call conflict detection between dry-run and commit.
- No schema/migration change - `FieldAuthorityPolicy` was already fully defined in Phase 1.

## Rollback plan

Revert this phase's commits. `WorkdayAdapter` falls back to Phase 3's behavior (no conflict detection - every incoming value simply overwrites, the pre-Phase-4 posture). No other phase's code depends on this one.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`createFieldAuthorityPolicy` is a real upsert**, matching `updateFieldMapping`'s own precedent - §3 names no separate update mutation for either.
2. **`hireDate`/`userId` cannot participate in conflict detection** - ADR-0139, a real, disclosed limitation inherited from Module 02's own bulk-import diff logic, not something this module invented or can unilaterally fix.
3. **The "admin-facing conflict review workflow" is read narrowly to mean "genuinely queryable, well-structured data," not a dashboard UI** - the actual dashboard is Phase 8's own named scope. No new mutation to "acknowledge"/"resolve" a flagged conflict exists yet, since §3 names none and a stateful review workflow needs its own design pass this phase didn't do.
4. **`FieldAuthorityPoliciesService` does not yet reject a policy on a diff-excluded field** (`hireDate`/`userId`) - ADR-0139 names this as a narrower, separate gap worth closing later (either reject such policies outright, or build the missing read path), not assumed away silently, but also not fixed in this phase.

## Out of scope for this phase (do not build yet)

- Real per-provider rate-limit enforcement (§5a) - Phase 5.
- Any ACD/streaming adapter - Phase 6.
- Remaining batch adapters (SAP SuccessFactors, ADP, Salesforce) - Phase 6b.
- `WebhookSubscription`/`WebhookDelivery`, the outbound dispatcher - Phase 7.
- Connector health dashboard (the actual admin UI screen for reviewing flagged conflicts), remaining GraphQL surface, dashboards/runbooks - Phase 8.
