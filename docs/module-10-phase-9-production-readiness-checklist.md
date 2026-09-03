# Module 10 Phase 9 Production Readiness Checklist

**The single most important line in this checklist**: this phase closed every disclosed gap from Phases 1-8 that was genuinely closable in code, and investigated the one that wasn't (JWT revocation) far enough to name the *real* blocker (core's OAuth client model has no non-tenant-scoped service-client concept) rather than declaring it done or building a broken workaround.

## Delivered in this phase (application code)

- [x] SCD Type 2 history for `AiGovernancePolicy`/`AiProviderConfig` (`ai_governance_policy_history`/`ai_provider_config_history`, trigger-maintained, append-only) - ADR-0132.
- [x] RBAC expanded from 2 to 10 gated operations across the full schema, each with a specific `resource:action` permission - ADR-0133.
- [x] `TenantTokenMatchGuard` - promotes the manual per-resolver tenant cross-check into a real guard, closing the "a future resolver forgets to call it" risk.
- [x] `ai_rbac_denials_total` metric, recorded directly inside all three guards - closes the Guards-run-before-Interceptors observability blind spot.
- [x] Fixed: `observability/prometheus.yml` never scraped ai-layer-service at all (port 8700 missing entirely) - the Phase 8 dashboard's own panels had nothing to read from.
- [x] This platform's first Prometheus alerting rules file (`observability/alert-rules-module-10.yml`), 4 rules scoped to this module's own security-relevant metrics.
- [x] `confidenceIndicator`'s circular-echo exploit (ADR-0131) closed - untrusted free-text fields redacted from the groundedness comparison baseline, proven against the exact prior exploit scenario.
- [x] `detectSuspiciousRationalePhrases` - a disclosed, incomplete heuristic that now forces `requiresHumanApproval: true` on a match, closing (not just flagging) ADR-0131's rationaleText-passthrough finding.
- [x] `OllamaReachabilityChecker` - real network validation at `configureAiProvider` time, disclosed as configuration-time-only, not continuous.
- [x] `question` length cap (4000 chars, a real cost/DoS guardrail) and `baseUrl` URL-format validation - two real, previously-missing validation gaps.
- [x] `AuthModule` - structural consistency with every other concern in this service.
- [x] GraphQL schema `description` metadata across all four core domain types (`AIInteraction`, `AIRecommendation`, `AIGovernancePolicy` + history, `AiProviderConfigSummary` + history).
- [x] 186 unit tests, up from 175 at the start of this phase.

## Explicitly investigated and NOT closed (a real blocker, not an oversight)

- [ ] **JWT revocation check via core's `/oauth/introspect`** - investigated in depth. The endpoint requires the caller to authenticate as a registered `OAuthClient`, and every `OAuthClient` row is tenant-scoped (`tenant_id NOT NULL` - no platform-wide/system client concept exists anywhere in core's schema). ai-layer-service is a cross-tenant backend with no way to hold "the right client credentials for whichever tenant's token just arrived." Closing this for real needs a schema/architecture change to core's own OAuth client model - out of this module's own scope. `AccessTokenGuard` still has no revocation check; the disclosed, bounded mitigation (short-lived tokens, `ACCESS_TOKEN_TTL_SECONDS = 720`) stands unchanged.

## Verification performed

- [x] `npm run typecheck` / `npm run build` / `npm run lint` / `npm test` (186/186) - clean at every incremental step, not just at the end.
- [x] **SCD triggers verified live** against the real Postgres instance: a real INSERT + two real UPDATEs proved `ai_governance_policy_history` opens/closes versions correctly and that an identical-value resubmission creates no extra row; a separate real INSERT + UPDATE proved `ai_provider_config_history` versions on a key-only rotation (different ciphertext, same provider/model) despite no "tracked column" changing.
- [x] **Every RBAC scenario live-verified** with a real ephemeral JWKS server and real signed JWTs (not mocks): missing token (401), wrong permission per distinct `ai_interaction:write`/`ai_recommendation:read`/`:write`/`:approve` permission (403, naming the exact missing permission), tenant mismatch (403 from `TenantTokenMatchGuard`), and success with a real DB write including a real `updated_by` UUID from the token's own `sub` claim.
- [x] **`ai_rbac_denials_total` confirmed live** via a direct `/metrics` read after real denied calls, showing distinct counts for `unauthenticated` and `forbidden_tenant_mismatch`.
- [x] **`OllamaReachabilityChecker` verified live** against a real local mock Ollama HTTP server (accepted) and a real unreachable port (rejected with the actual `fetch failed` network error surfaced to the caller).
- [x] **The confidenceIndicator fix proven, not just implemented**: the identical adversarial scenario ADR-0131 originally demonstrated crossing a `minConfidenceIndicator: 0.7` threshold now scores 0.5 and correctly fails it - a real before/after regression test, not just a new passing test.
- [x] A real NestJS DI issue was hit and fixed during the `AuthModule` restructuring (a live boot failure, not caught by unit tests alone) - guards referenced via `@UseGuards(GuardClass)` did not reliably resolve their own dependencies when registered only in an imported+exported sibling module in practice, despite that being the documented pattern; the three guards are now registered both in `AuthModule` (for structural clarity) and directly in `AiGraphQLModule` (for reliable resolution), disclosed in that module's own comment.

## Honestly disclosed gaps (not glossed over)

- [ ] **JWT revocation** - see above, a real architectural blocker at the core/platform level, not a Module 10 fix.
- [ ] **`ai_provider_config_history` grows on every key rotation**, not just meaningful changes - a real, disclosed volume characteristic of the "version on every update" design forced by non-deterministic encryption, not expected to be operationally significant given how infrequently tenants rotate keys in practice.
- [ ] **The suspicious-language detector is a fixed phrase list** - evadable by rephrasing, same disclosed-heuristic posture as when it was first built. It now has real teeth (forces human approval), but does not claim to catch every social-engineering attempt.
- [ ] **`OllamaReachabilityChecker` validates at configuration time only** - a firewall change or the tenant's instance going down afterward is not caught by this check; it is not a standing guarantee.
- [ ] The real security/red-team review of §5 itself, load testing, and chaos/game-day exercises remain outstanding - the same standing gap named in every prior phase's own checklist, now with a substantially narrower and more specific list of what that review should focus on first.
- [x] ~~No rate limiting or throttling anywhere in this service~~ - **closed
      by ADR-0162, found after Phase 9 closed.** Unlike every other gap on
      this page, this one was never disclosed in any phase's own checklist
      - `askQuestion`'s 4,000-character length cap was the only existing
      guard against abuse on any of the five `AIInteraction`-generating
      operations, each a real, billable LLM API call.
      `AiInteractionRateLimitGuard` (a fourth guard, added after
      `TenantTokenMatchGuard`) now token-bucket-limits each
      `(tenantId, actorId)` pair via `AiInteractionRateLimiterService` -
      in-process, single-instance-correct, the same disclosed trade-off
      integration-hub-service's own rate limiter already accepted
      (ADR-0140).
