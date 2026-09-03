# Module 10 Phase 8 Production Readiness Checklist

**The single most important line in this checklist**: `updateGovernancePolicy` and `configureAiProvider` — the most-repeated disclosed gap across every prior phase's own checklist — are now RBAC-gated for real, using this platform's own actual RBAC mechanism (core's `AccessTokenGuard`/`PermissionsGuard`, ADR-0035), not a fabricated placeholder invented for this module alone. Live-verified against a real JWKS server and real signed JWTs, not just unit-tested.

## Delivered in this phase (application code)

- [x] `test/unit/ai/security/prompt-injection.spec.ts` (30 tests) - structural untrusted-content-boundary proof across all five interaction types, parser hardening against a hypothetically-compromised response, governance-isolation proof, and two real, disclosed findings (below).
- [x] `AccessTokenGuard`/`PermissionsGuard`/`RequirePermissions`/`CurrentTokenClaims`/`assertTokenTenantMatches` (`src/auth/`) - real RBAC, own copies of core's already-implemented guards adapted for a remote-JWKS resource-server role.
- [x] `updateGovernancePolicy`/`configureAiProvider` gated with `ai_governance_policy:write`/`ai_provider_config:write` respectively, cross-checked against the request's own tenant context.
- [x] `ai_provider_config`/`ai_governance_policy` registered as real, seeded, grantable resources in core's own `src/database/seeds/run-seed.ts`.
- [x] `updatedBy` for both gated mutations now populated from the verified token's own `sub` claim - closing a small, previously-disclosed "no identity gRPC call wired" gap as a side effect, not a separate task.
- [x] `observability/grafana-dashboard-module-10.json`, mounted in `docker-compose.yml` (module-05/06's own dashboards were never mounted - this module doesn't inherit that gap).
- [x] 44 new unit tests, 156 total (up from 112) - 6 of which exercise a real, ephemeral local JWKS HTTP server and real signed JWTs end to end, not mocks.

## Explicitly NOT done here (later phases, or genuinely out of this module's own scope)

- [ ] RBAC on `decideRecommendation`, `pendingRecommendations`, `askQuestion`, or any of the four explanation queries - only the two mutations with an escalating, explicit disclosure history are gated this phase. Expanding further is a deliberate, separate future decision, following the same pattern this phase established, not a silent scope-creep item.
- [ ] A real security/red-team review of §5 - this module's own standing pre-launch gate, named in every phase's own checklist since Phase 5, still not something a build phase substitutes for. This phase's own findings (below) narrow what that review needs to focus on, but don't replace it.
- [ ] A fix for the `confidenceIndicator`/`groundedness` inflation path (below) - a real fix means redesigning groundedness to be adversarially robust, not a phase-scoped bug fix.
- [ ] Any UI/API change to surface `degraded_mode`/`confidence_indicator` alongside `rationaleText` on an approval screen, which would give a human reviewer some signal beyond the prose itself - not built, no such UI exists in this build at all.

## Verification performed

- [x] `npm run typecheck` / `npm run build` / `npm run lint` / `npm test` (156/156) on ai-layer-service - clean.
- [x] **Live, end-to-end RBAC verification** - not just unit tests: a real local HTTP server serving a real JWKS (freshly generated RSA keypair via `jose`), real signed JWTs, and a real running `node dist/src/main.js` instance against the same Postgres database used throughout this module's build:
  1. No `Authorization` header → `401 UNAUTHENTICATED`, "Missing Bearer access token."
  2. Valid token, missing the required permission → `403 FORBIDDEN`, naming the exact missing permission (`ai_provider_config:write` / `ai_governance_policy:write`).
  3. Valid token whose own `tenant_id` claim doesn't match a spoofed `x-tenant-id` header → `403 FORBIDDEN` from `assertTokenTenantMatches`.
  4. Fully valid request → success, with a real row written to `ai_layer.ai_provider_config` including a real `updated_by` UUID taken from the token's own `sub` claim (confirmed via a direct `psql` read with the tenant RLS GUC set).
  5. The read-only `aiProviderConfig` query confirmed still ungated (works with no token at all) - reading back "which provider is configured" is no more sensitive than any other tenant-scoped read.
- [x] `LlmCircuitBreakerService`/prompt-injection/RBAC test suites all re-confirmed stable across repeated full-suite runs (a one-off flaky failure was found and fixed - the JWKS test server's `afterAll` now properly awaits `server.close()` with connections drained, rather than a fire-and-forget close that could leave the worker process without a clean exit).

## Honestly disclosed gaps (not glossed over)

- [ ] **NestJS Guards run before `HttpMetricsInterceptor`** - a real, newly-introduced observability gap: every 401/403 this phase's new guards produce is invisible to `http_requests_total`/`http_request_duration_seconds` and every panel on the new dashboard. There is currently no metric anywhere that counts RBAC denials.
- [ ] **`AccessTokenGuard` has no revocation check** - core's own guard checks `TokenRevocationService.isRevoked`, a live DB read this service has no access to. A revoked-but-not-yet-expired token (≤720s window) would still pass. A disclosed, bounded, standard OIDC-resource-server trade-off, not an oversight.
- [ ] **`confidenceIndicator` can be measurably inflated by a self-reported-confidence-plus-context-echo attack** (ADR-0131) - proven with a real, passing test demonstrating an honest low-information response failing a `minConfidenceIndicator` threshold that a crafted, context-echoing response crosses. A narrow but real path connecting untrusted content to a security-relevant `auto_execute_low_risk` decision.
- [ ] **`rationaleText` reaches the human approver completely unfiltered** (ADR-0131) - no keyword filtering, no "does this claim an action already happened" check. Human-in-the-loop review is a defense against the human's own judgment being deceived by the model's own prose, not a code-level control - worth naming explicitly for anyone relying on it as if it were the latter.
- [ ] Load testing, chaos/game-day exercises, and the real security/red-team review itself - all still outstanding, same standing gap named in every prior phase's own checklist, now with a sharper set of specific findings for that review to start from.
