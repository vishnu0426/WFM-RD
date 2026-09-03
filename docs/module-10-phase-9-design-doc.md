# Module 10 Phase 9 Design Doc — AI Layer: Full Gap Closure, SCD History, and RBAC Expansion

**Status:** Approved for implementation
**Owner:** AI Layer pod.
**Scope:** Not one of §9's own numbered phases - a deliberate, explicitly-requested pass to close every disclosed gap across Phases 1-8 that is actually closable in code, add SCD Type 2 history to the two config tables (matching Module 02's own precedent), and bring the module's structure/documentation to a consistent, enterprise-grade baseline.

## Problem

Three distinct asks, three different shapes of work:

1. **"Close every code-closable gap."** ~15 disclosed gaps existed across 8 phases. Some are genuinely fixable in code (RBAC coverage, a metrics blind spot, two adversarially-motivated hardening fixes, an Ollama reachability check). Others require a decision this module can't make alone (a real security review needs real humans; a JWT revocation check needs a schema change to core's own OAuth client model, investigated and found infeasible without one - ADR-0133). The discipline here was distinguishing the two categories honestly rather than declaring victory on everything.
2. **"Use SCD type"** - clarified against this platform's own precedent (Org/Employee's trigger-maintained history tables, ADR-0009) rather than Policy's self-versioning-in-place flavor (ADR-0006), since `AIGovernancePolicy`/`AiProviderConfig` are both hot-path-read tables where history is a secondary audit trail, the same shape as Org/Employee, not a directly-addressable resource.
3. **"Enterprise structure"** - clarified as three concrete asks: stronger validation/error handling, consistent module organization, and full API documentation.

## Decisions

- **SCD history** (ADR-0132): trigger-maintained, append-only companion tables for both config entities, with one deliberate departure from the Org/Employee convention (`ai_provider_config_history` versions on every update, not just tracked-column changes, because a random-IV re-encryption makes key rotation undetectable by column comparison) and one hard rule (the encrypted key itself is never copied into history, at all).
- **RBAC expanded to the full schema** (ADR-0133): every write-adjacent operation now requires a specific permission (`ai_interaction:write`, `ai_recommendation:read`/`:write`/`:approve`), enforced by a new third guard (`TenantTokenMatchGuard`) that eliminates the "did every resolver remember to call the manual tenant-check" risk entirely.
- **Three real, adversarially-proven hardening fixes**: the `confidenceIndicator` circular-echo exploit ADR-0131 disclosed is now closed (redacting untrusted free-text fields from the groundedness baseline) and proven closed with the exact scenario that used to succeed; a suspicious-rationale detector now forces human approval on a phrase match, closing (not just flagging) the "human-in-the-loop can be socially engineered" finding; a real RBAC-denial metrics blind spot (Guards run before Interceptors) is fixed by recording directly inside the guards.
- **A real, narrow Ollama reachability check** at configuration time, disclosed as validating only at that moment, not continuously - plus two real validation guardrails (a `question` length cap, `baseUrl` format validation) that were simply missing before.
- **Structural**: `AuthModule` now exists, matching every other concern's own module; GraphQL schema descriptions added across the four core domain types, making introspection/API docs genuinely useful rather than relying solely on TypeScript-only comments.
- **Explicitly not faked**: the JWT revocation check. Investigated far enough to discover the real blocker (core's OAuth client model has no non-tenant-scoped service-client concept) and disclosed rather than building a broken or misleading workaround.

## Consequences / Verification

- 186 unit tests, up from 175 (112 at the end of the standalone Gemini/Ollama work, 156 at the end of Phase 8) - every new test exercises genuinely new behavior, not padding.
- Extensive live verification against the real Postgres instance and real ephemeral JWKS/mock-Ollama servers used throughout this session: the SCD triggers' exact versioning behavior (including the "identical resubmission creates no new version" and "key rotation always versions" distinction), every RBAC permission/tenant-mismatch scenario with a real DB write on success, the RBAC-denial metric appearing in `/metrics` after real denied calls, and the Ollama reachability check correctly accepting a real reachable mock server and rejecting an unreachable one.
- `npm run typecheck`/`build`/`lint`/`test` all clean throughout every incremental step, not just at the end.
- What's still outstanding, and stays outstanding: the real security/red-team review of §5 (this module's own standing pre-launch gate since Phase 5), and the JWT revocation gap, which needs a decision at the core/platform level, not a Module 10 fix.
