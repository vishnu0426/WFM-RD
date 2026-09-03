# Phase 5 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases (§0.5).

## Delivered in this phase (application code)

- [x] `core.outbox_events` transactional outbox (ADR-0039) - `AuditLogRepository.record`
      and `PoliciesRepository.createLineage`/`.supersede` each write their
      domain row and an `AuditEvent`/`PolicyChanged` outbox row atomically.
- [x] `CoreOutboxPublisherService` - drains the outbox on a 10-second
      schedule, retries up to 5 times, then routes to `agno.core.dlq.v1`.
- [x] `AuditService.RecordEvent` gRPC (§3.3) - synchronous `ai_rationale`
      validation (§2.2 rule 3) at the ingestion boundary, batched flush
      (`AuditEventBatcherService`, 2-second tick, grouped by tenant),
      retry-then-DLQ on a persistent flush failure (ADR-0040).
- [x] `GET /v1/audit-log` (§3.2, named explicitly) - cursor-based pagination,
      filterable by `actorType`/`resourceType`/`resourceId`/date range.
- [x] Audit instrumentation wired into `PolicyManagementController.create`
      and every `RoleManagementController` mutation (ADR-0041).
- [x] Unit tests (`AuditEventBatcherService`'s synchronous validation, batch
      grouping, retry/requeue, DLQ routing) and integration tests (the
      transactional outbox's atomicity for both `AuditEvent` and
      `PolicyChanged`, including that a rejected `ai_agent` write produces
      neither an `audit_log` row nor an outbox row) against real Postgres.
- [x] **Audit instrumentation for OAuth/SSO/SCIM/WebAuthn/`TenantIdentityProvidersController`
      write paths** (ADR-0044): `OAuthController` (token issuance/refresh/
      revocation, client registration), `SsoController` (successful
      federated login), `TenantIdentityProvidersController` (IdP config
      CRUD), `ScimUsersController`/`ScimGroupsController` (user/group
      provisioning), `WebAuthnController` (credential registration/deletion,
      successful passkey authentication) all now record `audit_log`
      entries. `AuditModule` was split (lightweight `AuditModule` +
      `AuditApiModule` composition root) to let `AuthModule`/`SsoModule`/
      `ScimModule`/`WebAuthnModule` depend on it without a DI cycle.
- [x] **A durable queue behind NATS for `AuditEventBatcherService`'s
      buffer** (ADR-0042): the in-memory array was replaced with
      `core.pending_audit_events`, a Postgres-backed queue structurally
      mirroring `core.outbox_events` - `enqueue` durably inserts a row
      before returning (fire-and-forget from the caller's side, cheap
      enough not to reintroduce the latency ADR-0040 avoided), and the
      flush tick reads/deletes from that table instead of a JS array. A
      process crash between `enqueue` and the next flush tick now loses
      nothing.
- [x] **Graceful-shutdown draining** (ADR-0042): `AuditEventBatcherService`
      implements `OnModuleDestroy` (best-effort final flush), and
      `main.ts` calls `app.enableShutdownHooks()` so Nest actually invokes
      it on SIGTERM/SIGINT. A hard kill (SIGKILL/OOM) still skips this -
      the durable queue above, not this hook, is what actually prevents
      loss in that case.
- [x] **JetStream stream provisioning** (ADR-0043): `npm run
      nats:provision-streams` (`scripts/provision-nats-streams.ts`)
      idempotently provisions `AGNO_CORE_AUDIT`/`AGNO_CORE_POLICY`/
      `AGNO_CORE_DLQ`/`AGNO_ORG_EVENTS`/`AGNO_ORG_DLQ` with explicit
      retention (`RetentionPolicy.Limits`, file storage, age + byte caps) -
      a standalone script run once per environment, the same shape as
      `npm run migration:run`, not something app boot owns.

## Explicitly NOT done here (needs a different owner, or a later phase, before go-live)

- [ ] **A live NATS broker was not available in the environment this phase
      was built/tested in.** `CoreOutboxPublisherService`'s retry/DLQ logic
      is unit-tested against a mocked `NatsClientService`; the outbox
      *write* (the correctness-critical, transactional half) is integration-
      tested against real Postgres. `npm run nats:provision-streams`
      (ADR-0043) has not been run against a live broker either - the
      script itself is typechecked but unexecuted, same posture as
      everything else in this list that needs a broker this environment
      doesn't have. End-to-end delivery to a live JetStream instance is
      unverified here - the same honest gap ADR-0019 already documented
      for Module 02's identical pattern.
- [ ] **The Identity & Audit Console** (§2a) that would consume
      `GET /v1/audit-log`/the NATS `AuditEvent` stream - a separate
      deliverable, out of this module's scope entirely.
- [ ] **Load testing** for the outbox drain loop and the audit batch flush
      under real write volume - no measurement exists; §0.5's ~500k
      audit rows/day capacity assumption (Phase 1's own README) has not
      been re-validated against an actual publishing pipeline now that one
      exists.
- [ ] **Penetration testing / SOC2 / ISO27001 program.** Same explicit
      non-goal as every previous phase (§9 of the source spec).
