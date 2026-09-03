# ADR-0048: Envoy fronts REST/GraphQL and gRPC on separate listeners; per-tenant rate limiting is scoped out, not faked

## Context
§1 names Envoy as this platform's gateway (explicitly replacing whatever
generic "API gateway" the source spec otherwise implied). §3.4 goes
further, naming a specific mechanism: a per-tenant rate-limit quota backed
by a `Policy` row (`PolicyType.RATE_LIMIT` already exists in
`src/modules/policy/entities/policy-type.enum.ts`, added in an earlier
phase with the doc comment "Backs the Envoy per-tenant rate-limit config
described in §3.4" - anticipated, never built). No Envoy config of any
kind existed before this phase.

## Decision
`envoy/envoy.yaml` (docker-compose service `envoy`, ports 8080 REST/
GraphQL, 8081 gRPC, 9901 admin) - two listeners, since gRPC needs HTTP/2
and this app's REST/GraphQL surface is plain HTTP/1.1-or-2:
`edge_http_listener` routes everything (`/oauth/*`, `/v1/*`, `/scim/*`,
`/webauthn/*`, `/.well-known/*`, `/graphql`) to one cluster;
`internal_grpc_listener` routes the gRPC surface (§3.3) to a second
cluster with `http2_protocol_options` set explicitly (gRPC requires H2;
Envoy doesn't infer that from context). Both clusters point at
`host.docker.internal` since this app runs on the host (`npm run
start:dev`), not as a docker-compose service - a real deployment points
these at that environment's actual service/mesh address instead.

**Rate limiting is deliberately two-tiered, and only the coarser tier is
built**: `envoy.filters.http.local_ratelimit` (a per-Envoy-instance token
bucket, 200 req/s, no per-tenant awareness at all) is wired in as a basic
DoS safety net. The per-tenant, `PolicyType.RATE_LIMIT`-driven quota §3.4
actually describes requires Envoy's *external* Rate Limit Service protocol
(`envoy.filters.http.ratelimit` calling out to a gRPC service implementing
`envoy.service.ratelimit.v3.RateLimitService`, which would look up each
request's tenant descriptor against `core.policies WHERE policy_type =
'rate_limit'`) - **not built this phase**. Building it means either vendoring
Envoy's own `rls.proto` (a meaningful new external protobuf dependency) or
hand-rolling an equivalent gRPC contract, plus a new always-on service -
correctly a separate, sizeable piece of work, not a corner that can be cut
inside this phase without it becoming the phase's only deliverable.

## Consequences
- `local_ratelimit`'s 200 req/s is global across every tenant and every
  route - a noisy tenant can still exhaust another tenant's effective
  headroom under this config. This is the concrete, named gap the
  external-RLS design above would close - tracked explicitly in the Phase
  6 readiness checklist, not silently implied to be handled.
- `PolicyType.RATE_LIMIT` policies can already be created/read today via
  `POST /v1/policies` / `GET /v1/policies/{id}/history` (§3.2, existing
  since Phase 4) and the GraphQL `policies(policyType: RATE_LIMIT)` query
  (ADR-0045) - the *data model and CRUD* half of this feature is real and
  usable now; only the *enforcement* half (an Envoy RLS reading that data)
  is the deferred piece.
- No JWT verification at the edge - Envoy here is routing + a coarse rate
  limit, not an authentication boundary. This app already verifies every
  JWT itself (`AccessTokenGuard`/`TokenService`); duplicating that at the
  edge would mean keeping two independent JWKS-aware verifiers in sync for
  no correctness benefit, only defense-in-depth this repo's threat model
  doesn't currently call for.
- No mTLS between Envoy and the upstream cluster, no autodiscovery
  (`STRICT_DNS` against a fixed host/port) - both are standard production
  hardening this local-dev/reference config doesn't attempt, consistent
  with `docker-compose.yml`'s own stated scope ("local development only").
