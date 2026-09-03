# Phase 5 Design Doc — Audit + AI Rationale Enforcement

**Status:** Approved for implementation
**Owner:** Platform Core pod (Module 01)
**Scope:** §8 Phase 5 — `AuditLog` append-only enforcement (already delivered
in Phase 1), `AuditService.RecordEvent` gRPC, the NATS outbox publisher for
`AuditEvent`/`PolicyChanged`, and `ai_rationale` guard enforcement. Depends
on Phase 1's `AuditLog`/`AuditLogRepository` and Phase 4's `Policy`
versioning already existing.

## Problem

Phase 1 built `AuditLogRepository.record` with the `ai_rationale` guard and
the append-only GRANT/CHECK-constraint enforcement already in place, but
explicitly deferred everything else: "Batching, the NATS outbox, and
retry/dead-letter semantics (`AuditService.RecordEvent`) are Phase 5 scope."
Nothing published an `AuditEvent` to NATS, nothing let an external service
(Scheduling, Forecasting) record an audit entry about its own actions
without direct database access, and nothing in this repo actually called
`record` from a real request path at all - the audit trail existed in
schema only.

## Decision

**Transactional outbox** (`CoreEventingModule`, ADR-0039): a new
`core.outbox_events` table, structurally identical to Module 02's
`org.outbox_events` (ADR-0019) but scoped to this module's own schema and
subjects. `AuditLogRepository.record` and `PoliciesRepository.createLineage`/
`.supersede` each write their domain row and an outbox row
(`agno.core.audit.created.v1` / `agno.core.policy.changed.v1`) in one
atomic transaction - "the audit entry exists but no event was queued" (or
the reverse) is not a reachable state. `CoreOutboxPublisherService` drains
the table on its own 10-second schedule, independent of whether NATS is
reachable at write time, with the same retry/DLQ (`agno.core.dlq.v1`) shape
Module 02 already established.

**`AuditService.RecordEvent` gRPC** (ADR-0040): `AuditEventBatcherService`
buffers validated events in memory and flushes them (grouped by tenant)
every 2 seconds, so the calling service's gRPC call returns immediately
without waiting for a Postgres round trip - true fire-and-forget from the
caller's perspective. §2.2 rule 3 (`ai_rationale` required for
`actor_type = ai_agent`) is checked **synchronously** in `enqueue`, before
anything is buffered, so a caller gets an immediate, correct rejection
rather than a false "accepted" for an event that would later fail silently
at flush time. A flush failure retries up to 3 times, then routes to the
DLQ - "must not silently drop audit events" is satisfied by that DLQ route
plus an ERROR-level log as the absolute last resort (see ADR-0040's
consequences for the honest limit of that guarantee).

**`GET /v1/audit-log`** (§3.2, named explicitly): cursor-based pagination
on `created_at` (not `OFFSET` - `audit_log` is this module's highest-
write-volume, partitioned table), filterable by `resourceType`/`resourceId`/
`actorType`/date range.

**Representative instrumentation, not an exhaustive retrofit** (ADR-0041):
`PolicyManagementController.create` and every `RoleManagementController`
mutation now call `AuditLogRepository.record` after a successful write -
two high-value, already-authenticated paths, not every mutation across
every prior phase.

## Blast radius

- One new table (`core.outbox_events`, Phase 5 migration), additive - no
  change to any existing table's columns.
- `AuditLogRepository.record`'s signature is unchanged; its transaction now
  does one additional insert (the outbox row) - existing callers (none yet
  outside this phase's own new instrumentation) are unaffected.
- `PoliciesRepository.createLineage` changed internally (from the inherited
  `TenantScopedRepository.save` to its own `withTenantTransaction` call) to
  make the outbox write atomic - its public signature and return type are
  unchanged.
- First gRPC contract whose primary job is *ingesting* data into this
  module (every other gRPC contract so far - `IdentityService`,
  `PolicyService` - is read-only from the caller's perspective).

## Rollback plan

Additive - reverting this phase means removing `CoreEventingModule` from
`app.module.ts`, `AuditGrpcController` from `GrpcModule`, the `audit.proto`
entry from `main.ts`, and the two `AuditLogRepository.record` call sites in
`PolicyManagementController`/`RoleManagementController`. The migration's
`down()` drops `core.outbox_events`. `AuditLogRepository.record`'s outbox
write is the one non-trivially-revertible piece (it's now inside the same
transaction as the `audit_log` insert) - reverting it means restoring the
simpler single-insert transaction Phase 1 shipped.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`core.outbox_events` is a new, separate table from Module 02's
   `org.outbox_events`**, not a shared one - see ADR-0039.
2. **`NatsClientService` is duplicated**, not extracted into shared
   `common/nats` infrastructure - see ADR-0039's trade-off.
3. **Only two write paths get audit instrumentation this phase** (Policy
   CRUD, RBAC mutations) - see ADR-0041. OAuth/SSO/SCIM/WebAuthn events are
   not yet recorded anywhere.
4. **`GET /v1/audit-log` pagination is cursor-based on `created_at`**, not
   `OFFSET`-based - not specified either way by §3.2, chosen for the
   reasons already established for this table's write volume (ADR-0005).
5. **A new `audit` resource was added to the permission catalog**
   (`audit:read`) - §2.1's `RESOURCES` list is illustrative, not exhaustive,
   and this endpoint needs a permission to gate on.

## Out of scope for this phase (do not build yet)

- The Identity & Audit Console (§2a of the source spec) that would actually
  *consume* `GET /v1/audit-log`/the `AuditEvent` NATS stream - that's a
  separate deliverable this module only produces data for.
- Consumer-side JetStream configuration (durable consumer names, ack
  policies, `max_deliver`) for whatever eventually reads the streams
  `npm run nats:provision-streams` provisions (ADR-0043) - no consumer
  exists in this repo yet, so there is nothing to configure against.
- Auditing failed mutations (a failed SSO callback, a rejected OAuth grant)
  as a distinct concern from auditing successful ones (ADR-0044) - a
  reasonable follow-up, not attempted this pass.

## Follow-up: closing the initial cut's gaps (ADR-0042/0043/0044)

The first cut of this phase explicitly deferred four items, each listed in
the production readiness checklist below. All four have since been closed:

- **Audit instrumentation for OAuth/SSO/SCIM/WebAuthn** (ADR-0041's named
  gap) - closed by ADR-0044. Required splitting `AuditModule` (a
  lightweight `AuditModule` + a new `AuditApiModule` composition root) so
  `AuthModule` itself could depend on it without a DI cycle - see
  ADR-0044 for why the original `AuditModule` shape couldn't support this.
- **A durable queue behind NATS for `AuditEventBatcherService`'s buffer**
  (ADR-0040's consequences) - closed by ADR-0042: the in-memory array
  became `core.pending_audit_events`, a Postgres-backed queue.
- **Graceful-shutdown draining** - closed by ADR-0042's `OnModuleDestroy`
  hook plus `main.ts`'s `app.enableShutdownHooks()`.
- **JetStream stream provisioning** - closed by ADR-0043's standalone
  `npm run nats:provision-streams` script.
