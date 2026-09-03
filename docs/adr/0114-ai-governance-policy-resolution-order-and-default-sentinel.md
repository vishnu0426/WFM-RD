# ADR-0114: `AIGovernancePolicy` resolution order — exact `action_type` → tenant's own `'default'` row → hardcoded platform default

## Context
§3 states the resolution order in prose ("tenant-specific row for the exact `action_type` → tenant-specific row for a broader/default `action_type` category (if the tenant hasn't configured this specific one) → platform default (`suggest_only`)") but leaves "broader/default category" undefined - there's no taxonomy anywhere in the source spec mapping specific `action_type` values (e.g. `reallocation.auto_swap`) onto a broader category (e.g. `reallocation.*`). Inventing a category taxonomy now, before any real `action_type` value exists anywhere in this platform (Phase 5 is the first code that creates an `AIRecommendation`, and therefore the first code that needs to resolve one), would be guessing at a shape with no real caller to validate it against.

## Decision
Resolution has exactly three tiers, matching §3's prose but resolving "category" as a per-tenant sentinel row rather than a taxonomy:

1. A tenant-specific `AIGovernancePolicy` row with `action_type` matching exactly.
2. A tenant-specific `AIGovernancePolicy` row with `action_type = 'default'` - the tenant's own configured fallback for any `action_type` they haven't set up individually. `'default'` is not a magic value at the schema level - it's stored and looked up as an ordinary `action_type` string (`ai_governance_policy_tenant_action_type_key`'s `UNIQUE (tenant_id, action_type)` treats it like any other value).
3. A hardcoded platform constant, `suggest_only` - never a database row. No tenant, and no platform operator, can configure a value here; it is the one autonomy level every `action_type` degrades to when nothing else applies, and it is always the safest level, never a more permissive one.

This is implemented as `AiGovernancePolicyResolverService.resolve(tenantId, actionType)` when Phase 5 builds it (`AIRecommendation` creation is the first real caller) - not built yet in Phase 1/2, since nothing in this module creates a recommendation until then. This ADR exists now, ahead of that code, because the schema (`ai_governance_policy_tenant_action_type_key`) and the entity's own doc comment already commit to this exact resolution shape (ADR-0113) - recording the reasoning here rather than letting Phase 5 rediscover it from a bare unique constraint.

## Consequences
- A tenant who never configures anything gets `suggest_only` for every `action_type`, platform-wide - the safe, conservative default §3 itself calls for.
- A tenant wanting one blanket autonomy level across every action type they haven't individually tuned writes exactly one `'default'` row - no need to enumerate every `action_type` value that exists today.
- If a real category taxonomy turns out to be needed later (e.g. "every `reallocation.*` action defaults to `approve_required`, independent of a tenant's own blanket `'default'`"), that's a four-tier resolution order and a real schema change - not something this ADR should have guessed at without a real caller driving the requirement.
