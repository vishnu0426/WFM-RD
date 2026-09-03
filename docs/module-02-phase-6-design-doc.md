# Module 02 Phase 6 Design Doc — Bulk HRIS Integration + Eventing

**Status:** Approved for implementation
**Owner:** Org & Employee pod (Module 02)
**Scope:** §8 Phase 6 — async bulk-import job pattern, dry-run mode, feature-flagged
rollout per tenant (§3.2, §0.5); §4's NATS JetStream eventing
(`EmployeeChanged`/`SkillExpiring`, transactional outbox, dead-letter stream).

## Decision

Two new modules. `EventingModule` (`OutboxEvent`, `NatsClientService`,
`OutboxPublisherService`) is infrastructure every other module can depend on one-way -
`EmployeeModule`'s repository and `SkillModule`'s decay job both write to the outbox
without needing to know anything about NATS itself (ADR-0019). `BulkImportModule`
(`BulkImportJob`, `FeatureFlag`, `BulkImportService`) owns §3.2/§0.5's async-job/
dry-run/feature-flag surface (ADR-0020), importing `EmployeeModule` (to actually
commit) and `OrgUnitModule` (to validate references) the same one-directional way
every other Phase 5-6 module has.

## Explicit assumptions

1. **Transactional outbox + a separately-scheduled publisher**, not a direct
   publish-in-request. See ADR-0019.
2. **NATS connects lazily; no broker is available in this dev environment.** The
   outbox write is fully tested against real Postgres; actual JetStream delivery is
   unverified end-to-end here (ADR-0019's own consequences section).
3. **`dryRun` defaults to `true`** when omitted from a bulk-import request. See
   ADR-0020.
4. **Bulk import is fire-and-forget in-process async, not a durable job queue.** A
   process crash mid-import is not resumable, unlike the decay job. See ADR-0020.
5. **JSON request body, not CSV** - §3.2 doesn't specify a wire format; JSON fits
   this repo's existing validation stack.
6. **`featureFlag`/`setFeatureFlag` GraphQL surface added**, not named by §3.1 - a
   flag with no API-reachable toggle isn't meaningfully "feature-flagged."

## Out of scope for this phase

- gRPC contracts for Scheduling/Forecasting (Phase 7).
- GDPR erasure workflow (Phase 8).
- A real job queue (BullMQ/SQS/etc.) for bulk import - explicitly flagged as needed
  before this handles production HRIS sync volumes.
- CSV/XLSX ingestion adapters.
