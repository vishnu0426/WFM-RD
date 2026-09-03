# Module 10 Phase 1 Design Doc — AI Layer: Schema & Migrations

**Status:** Approved for implementation
**Owner:** AI Layer pod (Module 10), with a Principal AI Safety/Security
Engineer role for §5 specifically — this module is the platform's only
aggregator of multi-tenant structured data into an LLM call, and that is
this build's actual novel-risk surface, not a routine schema exercise.
**Scope:** The §2.1 entity set — `AIInteraction`, `AIRecommendation`,
`AIGovernancePolicy` — including `degraded_mode` and the resolved-at-
creation-time `requires_human_approval` field from day one, in a new
standalone deployable, `ai-layer-service/` (Node/NestJS). `ai_layer` schema
+ `agno_ai_app` role (ADR-0113, extending ADR-0093/0108's pattern),
TypeORM data-source/runtime config, and the platform's standard
`/healthz`/`/readyz`/`/metrics` + tenant-context + domain-error-filter
scaffold. **No query router, no gRPC client, no LLM call, no GraphQL/REST
API surface beyond health/metrics, no NATS.** Those are Phase 2 onward per
§9's own build-phase list.

## Problem

Unlike every prior module, Module 10 owns no primary data domain of its
own — §2 is explicit that every structured fact it reasons over is
retrieved live via gRPC and stored in `AIInteraction.input_context` only as
an audit/reproducibility copy, never a live source. Two decisions this
phase had to settle before writing the migration:

1. **Does this module need Module 08's nullable-tenant-id, "platform
   default" RLS shape anywhere?** Checked explicitly, not assumed either
   way: `AIGovernancePolicy`'s own three-tier resolution order (§3) puts
   its safest fallback in application code (a hardcoded constant), never a
   database row — so no. All three tables get the plain, uniform
   `tenant_isolation` policy every non-nullable-tenant table in this
   platform already uses. See ADR-0113.
2. **Is `AIRecommendation.ai_interaction_id` a real FK or a JSONB
   snapshot pointer**, the way `core.outbox_events`/`core.pending_audit_events`
   reference their trigger rows? §2.1's own literal field list calls for
   "the full reasoning trace \[to be\] always reachable from the
   recommendation" — a real foreign key is the direct, correct
   implementation of that requirement, not a looser convention borrowed
   from an unrelated relay-table precedent.

## Decisions

- **Schema/role placement**: shared `agno_wfm` database, new `ai_layer`
  schema, new `agno_ai_app` role — the same pattern every module since
  Module 03 has followed (ADR-0017/0052/0066/0073/0083/0093/0108, restated
  here as ADR-0113).
- **Enum representation**: `varchar` + `CHECK`, not native Postgres `ENUM`
  (ADR-0003's platform-wide convention) — `interaction_type`,
  `source_module`, `status` (`AIRecommendation`), `autonomy_level`.
- **`confidence_indicator`**: `numeric(3,2)`, nullable — null only paired
  with `degraded_mode = true` or an absent `output_text`, enforced by a
  `CHECK` constraint (`ai_interaction_confidence_present_unless_degraded_check`)
  so §2.2 rule 4 ("always surfaced, never hidden") can't be silently
  violated by an application bug that forgets to compute it for a real
  response.
- **`AIRecommendation.supporting_data_json`**: `jsonb NOT NULL`, no
  default — §2.2 rule 2's "required, non-nullable... enforced at the
  schema level" taken literally.
- **`AIGovernancePolicy`**: `UNIQUE (tenant_id, action_type)` — one row per
  tenant per action type, including the `'default'` sentinel value ADR-0114
  documents as this module's own resolution of §3's "broader/default
  category" language.
- **No `DELETE` grant anywhere** — this phase has no retention/lifecycle
  job (unlike Module 08's `compliance_report`), so no reason to deviate
  from the platform's usual no-DELETE convention.

## Consequences / Verification

- Migration `1700009000000-InitialAiLayerSchema` applied and verified
  against a real, running Postgres instance in this session — `npm run
  migration:run` executed cleanly, RLS policies and grants confirmed via
  the migration's own query log, not just read back from the file.
- The service skeleton (`AppModule`, tenant context, health/metrics/domain-
  error scaffold) boots successfully end to end against that same real
  Postgres — verified via a real `NestFactory.create`/`app.listen` run in
  this session, not just `tsc --noEmit`/`nest build` passing.
- What's next: Phase 2 adds the first real capability (`explainSchedule`)
  and, per an explicit platform-owner decision made mid-build, a fourth
  table (`AiProviderConfig`, ADR-0117) this phase's own §2.1 reading did
  not anticipate — see the Phase 2 design doc.
