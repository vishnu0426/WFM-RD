# Module 08 Phase 2 Design Doc — Adherence & Compliance: ComplianceRule CRUD & Citation Enforcement

**Status:** Approved for implementation
**Owner:** Adherence & Compliance pod (Module 08), same Compliance/Legal-liaison
Architect framing as Phase 1 (§0) — this phase is where that framing first
touches real, callable code.
**Scope:** §7's own Phase 2 line: "ComplianceRule CRUD + citation
enforcement. Basic rule management, `status: pending_review` default,
`activateComplianceRule` as a distinct step." Concretely: `createComplianceRule`/
`activateComplianceRule` (GraphQL mutations, §3.1), `complianceRules(jurisdiction)`
(GraphQL query, §3.1), `GET /v1/compliance/rules/{jurisdiction}` (REST, §3.2).
This phase also resolves ADR-0095's explicitly-flagged open question — who
may write a platform-default `ComplianceRule` row — via ADR-0097. **No
`RuleChangeImpactPreview`, no gRPC surface, no `ValidatePolicyAgainstFloor`-
style definition comparison, no RBAC/permission check on who may call
`activateRule`, no report generation, no rollup job.** Those are Phases 3–8
per §7's own list.

## Problem

Three real decisions, beyond wiring up ordinary CRUD:

1. **Who can write a platform-default (`tenantId: null`) row?** ADR-0095
   deliberately left this unanswered at the RLS-policy level and flagged it
   as Phase 2's to resolve. Building a bespoke permission check for this one
   mutation would mean inventing a parallel authorization system for exactly
   the kind of decision RBAC exists to gate — and this module's own
   non-goals (§8) rule out touching Module 01's actual RBAC implementation.
   See ADR-0097: no self-service path exists at all; platform defaults are
   seeded directly against Postgres by whoever curates this data, outside
   this service's API surface entirely.
2. **How much of §2.2 rule 3's "stricter than the floor" validation belongs
   in this phase?** The spec's own closing sentence for that rule calls for
   a `ValidatePolicyAgainstFloor`-style check on a tenant's own override —
   but that comparison only means something once there's a real, shared
   floor-vs-override algorithm, and building it twice (once ad hoc here,
   once "for real" in Phase 4 as the actual gRPC method) is exactly the kind
   of drift risk §0.6 exists to prevent. This phase leans on the mechanism
   §2.2 rule 3 itself names as still mandatory regardless of automated
   validation — human review — which the `pending_review` → explicit
   `activateComplianceRule` state machine already provides structurally.
   The definition-comparison algorithm itself is Phase 4's to build once,
   shared by both this module's own write path and Module 02's.
3. **What does "the REST-equivalent of the gRPC contract Module 04 uses"
   (§3.2) mean before that gRPC contract exists?** Answered by extracting
   the resolution algorithm now, as a pure function
   (`resolveEffectiveRules`), so Phase 4's `GetActiveRule` can call the same
   code rather than re-deriving "which single rule is actually in force for
   this ruleType" a second time under its own deadline.

## Decision

**`ComplianceModule`** (`src/compliance/`): `ComplianceRuleService` — the one
place that writes or resolves `ComplianceRule` rows in this phase.
- `createRule(tenantId, input)`: trims and validates `citation` is non-empty
  (defense in depth ahead of the schema's own `compliance_rule_citation_required_check`),
  validates `effectiveTo >= effectiveFrom`, computes the next `version` for
  this exact `(tenantId, jurisdiction, ruleType)` scope, and inserts with
  `status: 'pending_review'`, `activatedAt: null`, `activationDelayUntil: null`.
  Always tenant-scoped — see ADR-0097.
- `activateRule(tenantId, ruleId, effectiveAt?)`: the separate, explicit
  go-live step §5a requires. Looks the rule up, rejects a missing rule
  (`ComplianceRuleNotFoundError`), a rule this tenant doesn't own —
  including a platform-default row, which RLS's own `USING` clause lets this
  tenant *read* but never legitimately activate (`ComplianceRuleNotOwnedError`,
  ADR-0097's consequence) — and a rule that isn't `pending_review`
  (`ComplianceRuleNotPendingReviewError`). On success: supersedes any other
  currently-`active` row in the same `(tenantId, jurisdiction, ruleType)`
  scope (without this, two rows could be simultaneously `active` for the
  same scope, breaking `resolveEffectiveRules`'s one-row-per-`ruleType`
  contract), then sets `status: 'active'`, `activatedAt: now()`, and
  `activationDelayUntil` from the optional `effectiveAt` argument — §0.5's
  progressive-delivery field: approved and live in status, but not counted
  as actually in force until that timestamp passes.
- `listRules(tenantId, jurisdiction)`: every rule visible to this tenant for
  this jurisdiction (own rows, any status, plus the platform default via
  RLS) — the admin management view, backing GraphQL's `complianceRules`
  query.
- `findEffectiveRules(tenantId, jurisdiction)`: `listRules` filtered through
  `resolveEffectiveRules` — what's actually in effect right now, one row per
  `ruleType` — backing REST's `GET /v1/compliance/rules/{jurisdiction}`.

**`resolveEffectiveRules(rules, asOf)`** (`src/compliance/resolve-effective-rules.ts`):
a pure function, deliberately factored out of the service so Phase 4's
`GetActiveRule` gRPC method can call the identical logic instead of
reimplementing it (§3.2's own "keep the two in sync as one canonical rule
representation" instruction, applied to code, not just wire format). Filters
to `status = 'active'` rows whose `effectiveFrom <= asOf`, `effectiveTo`
either unset or `>= asOf`, and `activationDelayUntil` either unset or
`<= asOf`; among survivors, groups by `ruleType` and keeps exactly one row —
a tenant-scoped row always wins over a platform default for the same type,
and among two rows of the same scope, the higher version wins.

**GraphQL** (`src/graphql/graphql.module.ts`, this service's first GraphQL
surface — `ComplianceGraphQLModule`, mirroring shift-marketplace-service's
own `MarketplaceGraphQLModule`): Apollo driver, `autoSchemaFile` →
`src/schema.gql`, `formatGraphQLError` mapping `DomainError` the same way
`DomainErrorFilter` does for REST. `ComplianceRuleResolver` exposes
`complianceRules(jurisdiction)`, `createComplianceRule(input)`,
`activateComplianceRule(ruleId, effectiveAt)`. `CreateComplianceRuleInput`
(`src/compliance/types.ts`) is decorated with both `@InputType()` and
`class-validator` decorators on one class — this platform's first GraphQL
input type that needs validation; every existing mutation elsewhere takes
bare scalar args, so there was no direct precedent to extend, and a single
class beats hand-keeping a DTO and an `@InputType()` in sync.
`ComplianceRuleType` is registered as a real GraphQL enum
(`registerEnumType`), reusing the same TS enum the schema's own `CHECK`
constraint backs — one vocabulary, not two. A hand-rolled `JsonScalar` (own
copy of shift-marketplace-service's) carries `ComplianceRule.definition`'s
arbitrary, `ruleType`-dependent shape.

**REST** (`src/compliance/compliance-rule.controller.ts`): `GET
/v1/compliance/rules/{jurisdiction}` returns `resolveEffectiveRules`'s
output directly — deliberately a *different* view from GraphQL's
`complianceRules` query (resolved-to-one-per-type vs. every-status
management listing), not two representations of the same data racing to
stay in sync.

**`withTenantConnection`** (`src/database/with-tenant-connection.ts`):
deferred out of Phase 1 (no request path existed yet to need it) — this
phase's `ComplianceRuleService` is its first caller in this service, own
copy of every other service's identical helper.

**Two REST-only global concerns needed the same GraphQL upgrade this
platform has already made twice before**, caught by actually booting the
service and exercising it with `curl`, not by any unit test: `HttpMetricsInterceptor`
assumed every request carried a real Express `Request`/`Response` pair
(`context.switchToHttp().getRequest()` throws under a GraphQL execution
context) — upgraded to intraday-service's own transport-branching version,
recording GraphQL requests with a `<Type>.<field>` route label instead of
either crashing or silently skipping them (shift-marketplace-service's
simpler fallback). `DomainErrorFilter` called `response.status()` on a
GraphQL context's response object, which has no such method — upgraded to
the identical detect-and-rethrow bailout intraday-service's and
shift-marketplace-service's own copies already use, letting
`formatGraphQLError` (`ComplianceGraphQLModule`) take over instead. Both are
now covered by this phase's own real-Postgres-and-real-process verification
run, not just asserted by comment.

## Blast radius
- New files only within `adherence-compliance-service/`: `src/compliance/`
  gains its service, controller, module, types, errors, and the pure
  resolution helper; `src/graphql/` is new entirely (module, JSON scalar,
  one resolver); `src/database/with-tenant-connection.ts` is new.
  `app.module.ts`/`common/metrics/metrics.service.ts`/
  `common/http/domain-error.filter.ts`/`package.json` gain additive changes
  only — nothing from Phase 1 is removed or restructured.
- No migration in this phase — Phase 1's schema already has every column
  this phase's code reads or writes (`status`, `activationDelayUntil`, the
  version-uniqueness partial indexes). No new ADR touches the schema itself;
  ADR-0097 is a write-authorization decision, not a DDL change.
- One new doc, one new ADR. Zero changes outside
  `adherence-compliance-service/` and `docs/`.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`createComplianceRule` cannot create a platform-default row, full
   stop — not "can, but only for an authorized caller."** ADR-0097 explains
   why: building a bespoke authorization gate for this one mutation would be
   a parallel RBAC system, and this module's own non-goals rule out
   extending Module 01's real one. Platform defaults exist only via direct
   seeding against Postgres as `agno_migrator`.
2. **The §2.2-rule-3 floor-comparison algorithm is not implemented in this
   phase**, even though the spec frames it as applying to "a tenant creating
   its own `ComplianceRule` override." The mandatory human-review gate
   (`pending_review` → explicit `activateComplianceRule`) already satisfies
   §2.2 rule 3's own fallback instruction ("flag this as needing a human
   legal reviewer... regardless of automated validation passing") — Phase 2
   simply doesn't yet have the automated half either, which is not a new
   gap this instruction wasn't already anticipating.
3. **`activateComplianceRule`/`createComplianceRule` have no RBAC/permission
   check on who may call them** — any request carrying a valid tenant
   context can do either. Module 01 integration is out of scope for this
   module per §8's explicit non-goals; a future phase adding a real
   permission gate (mirroring attendance-leave's `backdated_leave_entry:approve`
   pattern) is new, disclosed scope, not silently assumed away.
4. **GraphQL's `complianceRules` query and REST's `GET /v1/compliance/rules/{jurisdiction}`
   deliberately return different views** (every-status management listing
   vs. resolved-one-per-type). §3.2 describes REST as "the REST-equivalent of
   the gRPC contract Module 04 uses" — a consumption-oriented, resolved view —
   while §3.1 lists `complianceRules` as a plain listing query with no
   resolution language attached. Both are real, defensible readings of the
   same two sentences; this is the one this phase commits to.
5. **`ActivateComplianceRuleInput` is two bare scalar args
   (`ruleId`, `effectiveAt`), not a wrapper input object** — matching
   shift-marketplace-service's own convention for a mutation with only one
   or two arguments (`claimOpenShift(postId: ID)`), reserving a dedicated
   `@InputType()` for `createComplianceRule`, which genuinely has several
   fields.

## Out of scope for this phase (do not build yet)
- `RuleChangeImpactPreview` — Phase 5.
- The gRPC `ComplianceRuleService.GetActiveRule`/`ValidatePolicyAgainstFloor`
  surface, and the real Module 02/04 reconciliation work §0.6 requires —
  Phase 4. `resolveEffectiveRules` exists now specifically so that phase
  reuses it rather than re-deriving it.
- The §2.2-rule-3 definition-level floor-comparison algorithm itself — Phase
  4, shared with Module 02's `EmploymentPolicy` write path.
- `generateComplianceReport`, the rollup job, the retention lifecycle job —
  Phases 3/6/7, unaffected by this phase's work.
- Any RBAC/permission gate on `createComplianceRule`/`activateComplianceRule` —
  not scheduled by any phase in §7's list; would be new, flagged scope if
  ever added.

## Verification

Real local Postgres, not just unit tests: booted the app with
`ComplianceModule`/`ComplianceGraphQLModule` wired in, exercised
`createComplianceRule` → `pending_review` row with the caller's own
`tenantId`, `activateComplianceRule` → `active` with `activatedAt` set,
confirmed a second `createComplianceRule`/`activateComplianceRule` cycle for
the same `(jurisdiction, ruleType)` correctly supersedes the first
(`status: 'superseded'`), confirmed `GET /v1/compliance/rules/{jurisdiction}`
returns only the now-active row, and confirmed `activateComplianceRule`
against a manually-seeded platform-default row's id is rejected
(`ComplianceRuleNotOwnedError`) without ever reaching an UPDATE statement.
