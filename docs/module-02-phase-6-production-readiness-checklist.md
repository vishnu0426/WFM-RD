# Module 02 Phase 6 Production Readiness Checklist

Extends the Phase 1-5 checklists.

## Delivered in this phase

- [x] Transactional outbox (`org.outbox_events`), written atomically with the
      `Employee` row it describes (`EmployeesRepository.createWithOutboxEvent`/
      `updateWithOutboxEvent`) or standalone for `SkillExpiring`
      (`SkillDecayJobService`). ADR-0019.
- [x] `OutboxPublisherService`: polls every 10s, retries with attempt tracking,
      routes to `agno.org.dlq.v1` after 5 failed attempts.
- [x] `NatsClientService`: lazy connection, `NATS_URL`-configurable, doesn't block
      app boot.
- [x] `POST /v1/employees/bulk-import` (`202` + job, dry-run by default),
      `GET /v1/jobs/{id}`, `Idempotency-Key` support.
- [x] `org.feature_flags` + `FeatureFlagsService`, gating bulk import's destructive
      mode (`bulk_import_destructive`), exposed via GraphQL for toggling.

## Explicitly NOT done here

- [ ] **No real NATS broker verified.** The transactional outbox write is tested
      against real Postgres; end-to-end delivery to a live JetStream instance has
      not been exercised in this environment. `OutboxPublisherService`'s
      retry/DLQ logic is unit-tested with a mocked client instead.
- [ ] **`OutboxPublisherService` doesn't await in-flight ticks on shutdown.** An
      already-running tick (particularly the DLQ fallback path, which waits out a
      NATS connection timeout) can still be mid-flight when `app.close()` tears down
      the DataSource, producing a harmless but noisy `Connection terminated` log
      line after shutdown. Observed in this repo's own integration tests. Not a
      correctness issue (no state is corrupted - the retry counter update just never
      lands, so the next tick retries again), but a real graceful-shutdown gap worth
      closing before this runs somewhere shutdown timing matters.
- [ ] **No durable job queue for bulk import.** Fire-and-forget in-process async - a
      process crash mid-import is not resumable (unlike the decay job,
      ADR-0017). A real deployment needs BullMQ/SQS/equivalent before handling
      production HRIS sync volumes. See ADR-0020.
- [ ] **No CSV/XLSX ingestion.** JSON array request body only.
- [ ] **No rate limiting on `bulk-import`** despite it being explicitly named the
      highest-blast-radius endpoint in this module (§0.5) - rate limiting remains
      platform/gateway-level infra, same standing gap noted in the Phase 2
      checklist.
- [ ] **ABAC on `setFeatureFlag`.** Anyone with a valid `X-Tenant-Id` can toggle the
      destructive-import flag for that tenant - no admin-only restriction exists
      (the standing ADR-0014 gap).
- [ ] **Outbox table growth/retention.** No archival or pruning strategy for
      published `outbox_events` rows exists - unlike `audit_log`'s partition
      rotation (flagged, also unowned, in Module 01's own checklist), this table
      isn't even partitioned yet.
