# Module 08 Phase 2 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] `createComplianceRule` (GraphQL mutation): always tenant-scoped
      (ADR-0097 — there is no field, flag, or code path in this phase that
      can write a `tenantId: null` row), always lands in `status:
      'pending_review'`, computes the next `version` for its exact
      `(tenantId, jurisdiction, ruleType)` scope, trims and validates
      `citation` is non-empty (defense in depth ahead of the schema's own
      `compliance_rule_citation_required_check` — verified both paths
      reject independently: `class-validator`'s `@IsNotEmpty()` for a
      literal empty string, this service's own trim-check for a
      whitespace-only one), and validates `effectiveTo >= effectiveFrom`.
- [x] `activateComplianceRule` (GraphQL mutation): the separate, explicit
      go-live step §5a requires — rejects a missing rule, a rule this
      tenant doesn't own (including a platform-default row it can *read*
      via RLS but never legitimately activate, ADR-0097's consequence), and
      a rule that isn't `pending_review`. On success, supersedes any other
      currently-`active` row in the same scope and sets `activatedAt`/
      `activationDelayUntil` (§0.5's progressive-delivery field).
- [x] `complianceRules(jurisdiction)` (GraphQL query) and `GET
      /v1/compliance/rules/{jurisdiction}` (REST): two deliberately
      different views (every-status management listing vs.
      resolved-one-row-per-`ruleType`), both real, both exercised against
      real Postgres in this phase.
- [x] `resolveEffectiveRules` (`src/compliance/resolve-effective-rules.ts`):
      a pure, exported function — Phase 4's `GetActiveRule` gRPC method
      reuses this exact algorithm rather than re-deriving it, per §3.2's own
      "keep the two in sync" instruction applied to code.
- [x] This service's first GraphQL surface (`ComplianceGraphQLModule`),
      first GraphQL input type combining `@InputType()` and
      `class-validator` decorators on one class, first registered GraphQL
      enum (`ComplianceRuleType`, reusing the same TS enum the schema's
      `CHECK` constraint backs), and first `JsonScalar` (own copy of
      shift-marketplace-service's).
- [x] `withTenantConnection` (`src/database/with-tenant-connection.ts`) —
      deferred out of Phase 1, added now as this phase's first caller.
- [x] Two real bugs caught by booting this service for real and exercising
      it with `curl` — neither caught by unit tests, both fixed the same
      way this platform's two prior GraphQL-adding services (intraday-service,
      shift-marketplace-service) already hit and fixed identically:
      `HttpMetricsInterceptor` (assumed every request was a REST request;
      upgraded to the same transport-branching, `<Type>.<field>`-labeled
      GraphQL/REST split intraday-service's own copy uses) and
      `DomainErrorFilter` (called `response.status()` on a GraphQL
      context's non-Express response object; upgraded to the same
      detect-and-rethrow bailout intraday-service's/shift-marketplace-service's
      own copies use, letting `formatGraphQLError` handle the GraphQL
      shape instead).
- [x] ADR-0097, resolving ADR-0095's explicitly-flagged open question.
- [x] 18 new unit tests (`resolve-effective-rules.spec.ts`,
      `compliance-rule.service.spec.ts`) — 38 total in this service, all
      passing, no live Postgres required to run `npm test`.
- [x] Verified against a real local Postgres and a real running process
      (not just unit tests, not just a clean boot): `createComplianceRule` →
      `pending_review` row via `curl`+GraphQL; `activateComplianceRule` →
      `active`, `activatedAt` set; a second create/activate cycle for the
      same scope correctly supersedes the first (confirmed via both the
      GraphQL management view and the REST effective view showing exactly
      one row); a whitespace-only citation rejected by the service layer
      specifically (not just the DTO validator); a manually-seeded
      platform-default row readable via `complianceRules` but rejected by
      `activateComplianceRule` with a clean typed error, never reaching an
      `UPDATE` statement; `compliance_rule_creations_total`/
      `compliance_rule_activations_total` actually incrementing on
      `/metrics`.

## Explicitly NOT done here (needs a later phase)

- [ ] **Any RBAC/permission check on who may call `createComplianceRule`/
      `activateComplianceRule`.** Any request carrying a valid tenant
      context can do either — no check against Module 01's real permission
      system exists anywhere in this module, per §8's own explicit
      non-goals. Not silently assumed safe; explicitly flagged as absent.
- [ ] **The §2.2-rule-3 "is this override at least as strict as the floor"
      definition-comparison algorithm.** This phase relies entirely on the
      mandatory human-review gate (`pending_review` → explicit
      `activateComplianceRule`) that §2.2 rule 3 itself names as required
      regardless of automated validation. The automated comparison itself
      is Phase 4's `ValidatePolicyAgainstFloor` deliverable — until then, a
      tenant's own override is never automatically checked against the
      platform floor at all, only gated by a human deciding to activate it.
- [ ] **Any self-service path to create a platform-default `ComplianceRule`
      row.** ADR-0097's decision: none exists, none is planned as a Phase 2
      concern. The only platform-default rows in this system are the ones
      manually seeded via `agno_migrator` during this phase's own
      verification (and subsequently truncated).
- [ ] **`RuleChangeImpactPreview` — Phase 5.** `activateComplianceRule` does
      not check for, generate, or require a preview of any kind in this
      phase; it will happily supersede a version with zero visibility into
      what schedules that change might affect.
- [ ] **The gRPC `ComplianceRuleService` surface and the real Module 02/04
      reconciliation work §0.6 requires — Phase 4.** Nothing outside this
      service calls any of this phase's code yet.
- [ ] **`generateComplianceReport`, the rollup job, the retention lifecycle
      job — Phases 3/6/7,** unaffected by and unrelated to this phase's
      work.
- [ ] **No rate limiting on `createComplianceRule`.** A tenant could create
      an unbounded number of `pending_review` rows; nothing in this phase
      caps that. Same class of gap already flagged platform-wide for early
      phases of every prior module.
