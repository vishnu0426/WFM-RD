# ADR-0113: Module 10 schema — shared `agno_wfm` database, new `ai_layer` schema/role, uniformly tenant-scoped (no platform-default rows)

## Context
§2/§9 Phase 1 need the full entity set (`AIInteraction`, `AIRecommendation`, `AIGovernancePolicy`) in place before any query-router code exists to write to them - same "schema first, enforcement/API later" posture every module since Module 03 has followed.

Two decisions this module's own Phase 1 has to make that weren't fully pinned down by the source spec:

1. **Database/schema/role placement.** Follow the established shared-database, new-schema, new-role pattern (ADR-0017/0052/0066/0073/0083/0093/0108) rather than inventing anything new - `agno_ai_app` gets `USAGE` on `ai_layer` only, no access to `scheduling`/`org`/any other module's schema, matching §1's own framing that this module talks to every other module exclusively through gRPC contracts.
2. **RLS shape.** Module 08's `compliance_rule`/`retention_policy` precedent (ADR-0095) uses a nullable `tenant_id` for "platform-default, visible to every tenant" rows. Nothing in this module has an analogous concept - `AIGovernancePolicy`'s own §3 resolution order ("tenant-specific exact match -> tenant-specific broader/default category -> **platform default**") resolves its third tier in application code (a hardcoded `suggest_only` constant), never a database row with `tenant_id IS NULL`. So all three Phase 1 tables get the plain, uniform `tenant_isolation` RLS policy every other module's non-nullable-tenant tables already use - no special-cased policy to design or explain.

## Decision
- New Postgres role `agno_ai_app`, new schema `ai_layer`, following ADR-0002's `app.current_tenant_id` `set_config` convention exactly.
- `AIInteraction`/`AIRecommendation`/`AIGovernancePolicy` are all `tenant_id uuid NOT NULL`, each with the standard `FOR ALL USING (tenant_id = current_setting(...)) WITH CHECK (...)` policy - no nullable-tenant-id table anywhere in this module.
- `AIRecommendation.ai_interaction_id` is a real FK into `ai_interaction(id)` - §2.1's own literal field list ("links back to the AIInteraction that produced this recommendation, so the full reasoning trace is always reachable") makes this a genuine foreign key, not a JSONB snapshot pointer the way `core.outbox_events`/`core.pending_audit_events` reference their trigger rows.
- Standard grants: `SELECT, INSERT, UPDATE` only, no `DELETE` - this module has no retention/lifecycle-deletion job in this phase (unlike Module 08's `compliance_report`), so there's no reason to deviate from the platform's default no-DELETE convention yet.

## Consequences
- Every later phase's `AIRecommendation`/`AIGovernancePolicy` code (Phase 5) inherits a schema that's already correct and RLS-tested - no migration needed to "fix" a nullable-tenant-id design decision that turned out to be unnecessary here.
- If a future phase ever needs a genuine platform-default `AIGovernancePolicy` row (e.g. a platform-operator-configured default distinct from the hardcoded `suggest_only` constant), that's a real schema change (a new migration adding the nullable-tenant-id RLS variant), not something this ADR pre-emptively built for a need that doesn't exist yet.
