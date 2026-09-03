# ADR-0146: The mobile app consumes each owning module's real existing API — GraphQL or REST — never a parallel mobile-specific one

## Context

Module 11's source spec calls for the React Native app to call "the shared
GraphQL BFF directly when online, reaching Modules 02/04/06/07 through
their existing APIs exactly as a web client would," and explicitly forbids
a parallel mobile-specific API layer (§1, §8).

Investigating the actual platform to implement Phase 1's schedule screen
found two things worth recording before writing any code against them:

1. **There is no single, literal "shared GraphQL BFF" gateway service
   anywhere in this repo.** Every module — including this one — builds and
   serves its own independent GraphQL schema (where it has one) plus its
   own REST/gRPC surface. `docker-compose.yml` only lists infrastructure
   (Postgres, NATS, Redis, Envoy, Prometheus, Grafana), not per-module
   service containers, and Envoy fronts only the root platform-core
   service's own REST+GraphQL, not a multi-service gateway.
2. **There is no GraphQL query anywhere for "an employee's own upcoming
   shift assignments."** The only thing that exists is scheduling-service's
   REST endpoint `GET /v1/scheduling/employees/{employeeId}/shift-
   assignments?from=&to=` (Python/FastAPI, added Module 05 Phase 2 per its
   own docstring, docs/adr/0064), scoped by the same trusted `X-Tenant-Id`
   header every other backend-to-backend caller in this platform uses.

## Decision

Interpret "shared GraphQL BFF" as its actual intent, not its literal
wording: the mobile app is a client like any other, consuming whatever API
surface an owning module actually exposes — GraphQL where one exists, REST
where that's what's real — never inventing a parallel mobile-specific
endpoint of its own. Phase 1's schedule screen therefore calls
scheduling-service's existing REST endpoint directly
(`src/api/scheduling.ts`), rather than either (a) fabricating a GraphQL
resolver that doesn't exist anywhere in scheduling-service's stack (it's a
Python/FastAPI service with no GraphQL at all), or (b) adding a new
mobile-specific endpoint, which §8's non-goals explicitly rule out — if a
future mobile screen needs a capability that genuinely doesn't exist yet,
that capability belongs in its owning module, not bolted onto Module 11.

This is the same principle Module 07 §0 established for offline-sync
validation ("never a separately maintained rule set") applied one level up:
not just "reuse the validation logic," but "reuse the API surface itself."

## Consequences

- No new backend endpoint was written or is needed for Phase 1. Zero
  changes to scheduling-service or any other existing service.
- A future engineer adding a mobile screen must resist writing a "quick
  mobile-only endpoint" even when the real API is REST instead of GraphQL,
  or awkwardly shaped for a mobile payload — GraphQL's own field-selection
  (where a GraphQL surface exists) is the platform's answer to "lighter
  mobile payload," not a parallel API.
- If a genuinely new capability is needed later (e.g., a shift name/code
  field scheduling-service's `EmployeeShiftAssignmentResponse` doesn't
  return today), the fix is a change to that owning module's real API, with
  its own review and its own ADR in that module's docs — not a Module 11
  workaround.
