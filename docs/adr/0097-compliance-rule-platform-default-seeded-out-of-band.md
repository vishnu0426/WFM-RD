# ADR-0097: `createComplianceRule` always creates a tenant-scoped row; platform-default rows are seeded out of band

## Context
ADR-0095 (Phase 1) designed `compliance_rule`'s RLS policy so a tenant
connection can read a platform-default (`tenantId: null`) row but
structurally cannot write one — and explicitly left open *who or what* is
authorized to create one, flagging it as "Phase 2 must decide." Phase 2
(this module's first real write path, `createComplianceRule`) is that
phase.

Two live options:
1. **A privileged mode of the same mutation** — `createComplianceRule`
   accepts an optional flag/permission letting an authorized caller create
   a `tenantId: null` row through the ordinary API surface, gated by some
   new platform-admin permission check.
2. **No self-service path at all** — `createComplianceRule` only ever
   creates tenant-scoped rows; a platform-default row is written directly
   against Postgres by whoever owns the `compliance` schema's data
   (`agno_migrator`, which bypasses RLS as table owner — verified in Phase
   1), via a seed script or an internal tool outside this service's own API.

Option 1 requires a platform-admin/permission concept this codebase does
not have yet. Module 01 owns RBAC platform-wide (its `RESOURCES` seed array,
the pattern attendance-leave's `backdated_leave_entry:approve` permission
followed) — and per §8's own explicit non-goals, this module does not
rewrite or extend Module 01's code. Building a bespoke, Module-08-only
permission check to gate a single mutation would be exactly the kind of
parallel authorization system this platform's RBAC convention exists to
prevent, for a capability ("declare what a jurisdiction's law requires,
platform-wide") that is inherently rarer and higher-stakes than ordinary
tenant self-service — this is legal/compliance-officer-curated reference
data, not user-generated content.

## Decision
**Option 2.** `createComplianceRule` (GraphQL mutation, `CreateComplianceRuleInput`)
has no field for `tenantId` and no field for "make this a platform
default" — every row it ever creates has `tenantId` set to the caller's own
tenant, full stop (`ComplianceRuleService.createRule`, enforced by
construction, not by a runtime check). A platform-default `ComplianceRule`
row is written directly against `compliance.compliance_rule` by a process
credentialed as `agno_migrator` (the schema owner) — a seed script, run by
whoever this platform designates to curate labor-law reference data
(engineering ops acting on instruction from the Compliance/Legal-liaison
Architect role §0 names for this module), not through any REST/GraphQL
call this service exposes.

This is a deliberately narrow decision, not a permanent architectural
stance: if a future phase (or a future module prompt revision) genuinely
needs self-service platform-default authoring — e.g. a dedicated internal
tool for the compliance/legal team, itself gated by real Module 01 RBAC —
that is new scope requiring its own design work and its own ADR, not
something this ADR should be stretched to justify inventing casually.

## Consequences
- `ComplianceRuleService.createRule`'s signature takes `tenantId` as a
  required, non-optional parameter sourced from `TenantContextService`,
  never from the request body — there is no `input.tenantId` to trust or
  distrust in the first place.
- Every `ComplianceRule` row this service's own API has ever written, as of
  Phase 2, is tenant-scoped. The two rows seeded manually during this
  phase's real-Postgres verification (`US-CA` / `rest_period_minimum`) are
  the only platform-default data that exists anywhere in this system, and
  they were written directly via `agno_migrator`, exactly as this ADR
  prescribes — not through `createComplianceRule`.
- §2.2 rule 3's UI-facing "flag this as needing a human legal reviewer"
  instruction, for a tenant's own override, is unaffected by this decision —
  it already applies to every tenant-scoped row this mutation creates,
  independent of how platform defaults get seeded.
- `activateRule`'s explicit ownership check (`existing.tenantId !== tenantId`
  → `ComplianceRuleNotOwnedError`) exists as a direct consequence: since
  RLS's `USING` clause lets a tenant *read* a platform-default row
  (ADR-0095), and this module's `activateRule` looks the rule up by id
  alone before checking ownership, a naive implementation could reach a
  platform-default row's id and attempt to activate it. Postgres RLS's own
  `WITH CHECK` would still reject that `UPDATE` (verified against a real
  instance), but this service returns a clean typed error instead of
  surfacing a raw RLS-violation exception to the caller.
