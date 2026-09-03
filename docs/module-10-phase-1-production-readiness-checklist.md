# Module 10 Phase 1 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] Full §2.1 schema — `ai_interaction`, `ai_recommendation`,
      `ai_governance_policy` — one migration
      (`1700009000000-InitialAiLayerSchema.ts`), new `ai_layer` schema/
      `agno_ai_app` role (ADR-0113), uniform tenant-scoped RLS on all three
      tables (no nullable-tenant-id platform-default shape needed — see
      ADR-0113 for why that's a real decision, not an oversight),
      `varchar`+`CHECK` enums (ADR-0003), tenant-id-first indexes,
      `AIRecommendation.ai_interaction_id` as a real FK.
- [x] Schema-level enforcement of §2.2's non-negotiables: `confidence_indicator`
      can't be silently null for a real (non-degraded) response
      (`ai_interaction_confidence_present_unless_degraded_check`),
      `AIRecommendation.supporting_data_json` is `NOT NULL` with no default,
      `requires_human_approval` has no "recompute later" mechanism anywhere
      in the schema (it's just a plain boolean column, set once at
      creation).
- [x] TypeORM entity classes (`src/ai/entities/`), each backed by a TS enum.
- [x] `/healthz` (liveness) / `/readyz` (Postgres-gated — deliberately does
      NOT gate on the Anthropic/OpenAI API, since an LLM outage is §4's
      degraded-mode path, not a reason to pull this instance from rotation)
      / `/metrics` (Prometheus: HTTP/GraphQL request duration+count, plus
      six module-specific metrics declared now against §0.5/§8's asks even
      though nothing records into most of them until Phase 2+ —
      `ai_interaction_duration_seconds`, `ai_llm_api_calls_total`,
      `ai_circuit_breaker_state_transitions_total`,
      `ai_degraded_mode_interactions_total`,
      `ai_tenant_scope_assertion_failures_total`, `ai_interactions_total`,
      `ai_recommendations_by_autonomy_level_total`).
- [x] `npm run migration:run` executed against a real, running Postgres in
      this session — not just written and assumed correct. The service
      itself boots end to end (`NestFactory.create`/`app.listen`) against
      that same real instance.

## Explicitly NOT done here (later phases, named in §9)

- [ ] Query router, any gRPC client, any LLM call, any GraphQL/REST surface
      beyond health/metrics, NATS publication. All Phase 2+.
- [ ] `AiGovernancePolicyResolverService` — the resolution order this
      phase's schema/ADR-0114 already commits to is not yet implemented in
      code; nothing creates an `AIRecommendation` until Phase 5.
- [ ] Auth/RBAC enforcement — `TenantContextMiddleware` trusts an
      `X-Tenant-Id` header as-is, the same placeholder every module's own
      Phase 1 starts with (ADR-0014). No mutation exists yet in this phase
      for this to matter for, but it will from Phase 2 onward.

## Verification performed

- [x] `npm run typecheck` / `npm run build` / `npm run lint` — all clean.
- [x] Real migration run against a real Postgres instance in this
      environment (not mocked, not assumed).
- [x] Real application boot (`NestFactory.create` + `app.listen`) against
      that same instance, confirming DI wiring, TypeORM entity
      registration, and the tenant-context/health/metrics scaffold all
      resolve correctly together.

## Not yet applicable / genuinely out of reach this phase

- [ ] Load testing, chaos/game-day exercises (§0.5) — nothing exists yet
      for either to exercise.
- [ ] A real security review of anything (§5's own explicit standing
      requirement) — no code path handles tenant data yet in this phase.
