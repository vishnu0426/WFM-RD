# Phase 4 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases (§0.5).

## Delivered in this phase (application code)

- [x] `PermissionsGuard` + `@RequirePermissions(...)` - RBAC enforcement
      reading §3.4's JWT `permissions` claim, applied to every Phase 4
      endpoint plus a retroactive fix to Phase 3's `TenantIdentityProvidersController`.
- [x] `AbacService` - fresh-lookup, exact-org-unit-match ABAC enforcement
      (ADR-0035, ADR-0036), wired into `PolicyManagementService` for
      org-unit-scoped policy writes.
- [x] `POST /v1/policies` (create/version) and `GET /v1/policies/{policyId}/history` -
      §3.2's explicitly-named endpoints, backed by an atomic
      `PoliciesRepository.supersede` transaction (close old version + open
      new one in one commit).
- [x] `PolicyService.GetActivePolicy` gRPC (§3.3) - resolves "active as of"
      an arbitrary timestamp, both tenant-wide and org-unit-scoped lookups.
- [x] Role/Permission/UserRole management REST API
      (`/v1/roles`, `/v1/permissions`, `/v1/users/{id}/roles`) - full CRUD
      plus permission binding and ABAC-scoped role assignment.
- [x] `UserContextCacheService` invalidation wired into every RBAC mutation
      that can change a live user's effective permissions (ADR-0038) -
      closing the gap Phase 2 explicitly left open for this phase.
- [x] `PolicyApiModule`/`IdentityApiModule` composition-root pattern,
      avoiding a circular module dependency (ADR-0037) - the same shape
      Module 02's `OrgApiModule` already established.
- [x] Unit tests (`PermissionsGuard`'s allow/deny/missing-claims paths,
      `RoleManagementService`'s validation logic) and integration tests
      (RBAC-vs-ABAC scoping distinction, full policy lineage versioning
      transaction, type+scope active-policy resolution) against real Postgres.

## Explicitly NOT done here (needs a different owner, or a later phase, before go-live)

- [ ] **Subtree-aware ABAC.** §3.1's own "scoped to their org-unit subtree"
      example is not fully delivered - only exact-org-unit-match. Needs a
      new Module 02 gRPC contract (`OrgUnitService.IsWithinSubtree` or
      equivalent) this phase does not build. See ADR-0036.
- [ ] **A blanket RBAC retrofit across every pre-existing endpoint.** Only
      `TenantIdentityProvidersController` was gated this phase (the specific
      TODO Phase 3 flagged). Module 02's endpoints, and any other Module 01
      `/v1/*` route predating this phase, remain ungated (tenant-context-only,
      ADR-0014's placeholder posture) until deliberately revisited.
- [ ] **Immediate access-token revocation on a role change.** Cache
      invalidation (ADR-0038) makes the *next* token reflect a role change
      immediately; an already-issued access token's claims are frozen until
      it naturally expires (at most 12 minutes). Pair a sensitive role
      change with `RefreshTokenService.revokeAllSessionsForUser` if
      immediate effect is required.
- [ ] **`AuditService.RecordEvent` for RBAC/policy mutations.** Nothing in
      this phase writes to `audit_log` - who changed which role/policy and
      when is not yet recorded anywhere durable. Explicit Phase 5 scope.
- [ ] **Load testing for `AbacService`'s per-request query.** No load test
      exists; the join is reasoned to be cheap (indexed FKs, small
      per-tenant role-assignment counts) but not measured.
- [ ] **Penetration testing / SOC2 / ISO27001 program.** Same explicit
      non-goal as every previous phase (§9 of the source spec) - this phase
      is the first to actually *enforce* authorization anywhere in this
      repo, which makes independent verification of that enforcement more
      important here than in prior phases, not less.
