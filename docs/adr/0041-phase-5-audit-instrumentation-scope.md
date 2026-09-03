# ADR-0041: Phase 5 wires audit recording into Policy CRUD and RBAC mutations only, not every prior-phase write path

## Context
`AuditLogRepository.record` has existed since Phase 1, but until this phase
nothing in the codebase ever called it from a real request path - every
mutating endpoint built across Phases 2-4 (OAuth token issuance, SSO
federation, SCIM provisioning, WebAuthn registration, RBAC/Policy changes)
writes to its own domain tables but none of them write an `audit_log` entry
describing what happened. Wiring audit recording into literally every
mutation across four phases' worth of endpoints in one pass is a large,
diffuse change with real review cost.

## Decision
Phase 5 wires `AuditLogRepository.record` into exactly two representative,
already-authenticated write paths: `PolicyManagementController.create`
(§4's own named `PolicyChanged` event pairs naturally with an audit entry
for who changed it) and every mutation on `RoleManagementController`
(role/permission/assignment changes - a security-critical trail by nature).
Both already have a validated actor (`AccessTokenGuard`'s `tokenClaims.sub`)
and an already-open `AuditModule` dependency path (ADR-0037's composition-
module pattern), making them the lowest-friction, highest-value places to
close the loop first. This is the same scope discipline ADR from Phase 4
(RBAC gating applied only to `TenantIdentityProvidersController`, not
retrofitted everywhere) applied again here.

## Consequences
- **No audit trail exists yet for**: OAuth token issuance/revocation, SSO
  logins, SCIM user/group provisioning and deprovisioning, WebAuthn
  credential registration, `TenantIdentityProvidersController`'s IdP config
  changes. Every one of these is a legitimate audit-worthy event this
  platform's compliance posture will eventually need, and none of them are
  wired yet. This is a real, load-bearing gap, not a nice-to-have - listed
  explicitly in the production readiness checklist so it isn't lost.
- The `AuditService.RecordEvent` gRPC contract (§3.3) is available *right
  now* for any future write path (in this module or another) to call,
  in-process or cross-service - closing the remaining gaps is additive work
  using infrastructure this phase already built, not a new design effort.
- `AuditEventPayload`'s `action` strings introduced this phase
  (`role.created`, `role.deleted`, `role.permission.bound`,
  `role.permission.unbound`, `user_role.assigned`, `user_role.revoked`,
  `policy.created`, `policy.versioned`) are the first concrete instances of
  this module's audit action-naming convention - `<resource>.<verb>` or
  `<resource>.<sub_resource>.<verb>`. Future instrumentation should follow
  the same shape for consistency, not invent a parallel one.
