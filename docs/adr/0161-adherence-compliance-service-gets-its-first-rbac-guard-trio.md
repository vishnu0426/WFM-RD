# ADR-0161: adherence-compliance-service gets its first RBAC guard trio, closing this module's own long-standing "no RBAC anywhere" gap

## Context

Unlike integration-hub-service (ADR-0145) and ai-layer-service (ADR-0130),
which each shipped with RBAC gating at least their highest-risk mutations,
adherence-compliance-service had **no RBAC infrastructure of its own
whatsoever** - this was §8's own explicit non-goal, stated in Phase 1 and
never revisited through Phase 8. The Phase 8 readiness checklist named it
plainly: "Every write path (`createComplianceRule`, `activateComplianceRule`,
`generateRuleChangeImpactPreview`, `generateComplianceReport`,
`PATCH .../legal-hold`) is reachable by any caller holding a valid tenant
id, with no further check." That's a materially bigger surface than either
of the two RBAC-gated modules started with - not two writes, but every
write this service has, including a legal-hold toggle that determines
whether a compliance report can ever be deleted by the retention lifecycle
job.

## Decision

**Copy the platform's established RBAC guard trio wholesale** - a new
`src/auth/` directory (`access-token.guard.ts`, `permissions.guard.ts`,
`tenant-token-match.guard.ts`, `require-permissions.decorator.ts`,
`current-token-claims.decorator.ts`, `auth.module.ts`), identical in shape
to integration-hub-service's/ai-layer-service's own copies, not a new
design. This service now depends on `jose` (`^5.10.0`, matching the exact
version both prior copies pin) for the first time.

**Two new permission resources, `compliance_rule` and `compliance_report`**,
added to core's seed (`src/database/seeds/run-seed.ts`'s `RESOURCES`
array) - this service has no local permissions table of its own (same as
every other remote-JWKS-resource-server module), so the permission
strings its `PermissionsGuard` checks have to exist in core to be
grantable at all.

**Permission mapping, reusing the fixed `read`/`write`/`approve`/`delete`
action vocabulary rather than inventing new ones:**
- `compliance_rule:read` - `complianceRules` (GraphQL query),
  `GET /v1/compliance/rules/{jurisdiction}` (REST).
- `compliance_rule:write` - `createComplianceRule`, `activateComplianceRule`,
  `generateRuleChangeImpactPreview` - all three grouped under one
  permission, the same "any mutation on this resource" grouping
  `integration_connector:write` already covers across `createConnector`
  or `RelayController`'s start/stop (ADR-0160).
- `compliance_report:read` - `GET /v1/compliance/reports/{id}`.
- `compliance_report:write` - `POST /v1/compliance/reports`.
- `compliance_report:approve` - `PATCH .../legal-hold` - deliberately
  **not** folded into `:write`. Placing or lifting a legal hold is a
  materially different, higher-stakes action than generating a report (it
  determines whether the retention lifecycle job can ever delete the row)
  - the same `ai_recommendation:approve`/`role:delete` precedent for
    giving a write-adjacent-but-distinct action its own permission.

**Left untouched, deliberately:**
- `AdherenceScoreResolver.adherenceScoreToday` (Module 11's own
  employee-self-service query, ADR-0156) - gating it with an admin-style
  permission would break the legitimate case of an employee reading their
  own adherence score without an admin-granted permission; that surface
  needs an identity-match check (verify the JWT's own subject against the
  requested `employeeId`), the same pattern Module 06/11's own
  `EmployeeSessionVerificationService` established, not this ADR's RBAC
  guard trio. Out of scope here.
- The two gRPC controllers (`ComplianceRuleService`, `AdherenceRollupService`)
  - internal service-to-service calls in this platform don't carry a JWT
  bearer token under the current header-trust-everywhere posture (ADR-0014);
  gating gRPC the same way REST/GraphQL are gated here would need a
  different mechanism (mTLS or a service-credential flow), a larger,
  separate, platform-wide decision.

## Consequences

- Verified with a real end-to-end guard test
  (`test/integration/rbac.spec.ts`, own copy of integration-hub-service's
  identical test): a real local JWKS server, real signed RS256 JWTs, and
  the actual guard classes these five endpoints now use - 7 tests covering
  valid-token success, missing/wrong-key/expired token rejection, missing
  permission, an ungated handler passing through, and a tenant/token
  mismatch.
- `tsc --noEmit`, `eslint`, and the full 192-test unit suite all pass
  unchanged - no existing test exercises these five endpoints through the
  HTTP/GraphQL layer `@UseGuards` enforces (all existing coverage calls
  the underlying services directly), so nothing broke.
- `compliance_rbac_denials_total` (labeled `reason`, same shape as every
  other RBAC-gated service's identical metric) is this module's first RBAC
  observability signal.
- The two deliberately-untouched surfaces above remain real, disclosed
  gaps - this ADR closed the specific "no RBAC at all" finding, not every
  authorization question this module has.
