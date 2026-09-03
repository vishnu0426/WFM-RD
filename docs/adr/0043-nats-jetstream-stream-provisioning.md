# ADR-0043: JetStream streams are provisioned by a standalone script, not by application boot

## Context
`NatsClientService.publish` (both Module 01's `core-eventing` copy and
Module 02's `eventing` copy) calls `conn.jetstream().publish(subject,
payload)`. JetStream `publish` only succeeds if some stream already exists
server-side whose subject filter captures the subject being published to -
unlike plain core NATS, JetStream does not implicitly create storage for a
subject nobody has configured. Nothing in this repo ever provisioned those
streams; §4's own requirement to "define the actual retention policy,
don't leave storage unbounded" had no concrete answer. The Phase 5
production readiness checklist flagged this explicitly, deferring it as
"infra/ops config, not something a migration or application boot step
should own" - true as far as it went, but left the gap genuinely open
rather than closed by *some* piece of code.

## Decision
`scripts/provision-nats-streams.ts` (`npm run nats:provision-streams`)
provisions five streams via the JetStream Manager API
(`connection.jetstreamManager()`):

| Stream | Subjects | Retention | Rationale |
|---|---|---|---|
| `AGNO_CORE_AUDIT` | `agno.core.audit.>` | 30 days, 5 GiB | matches `audit_log`'s own monthly-partition rhythm (ADR-0005) |
| `AGNO_CORE_POLICY` | `agno.core.policy.>` | 90 days, 1 GiB | policy changes are low-volume, high-consequence - keep longer |
| `AGNO_CORE_DLQ` | `agno.core.dlq.>` | 180 days, 2 GiB | dead letters need to survive long enough for manual triage |
| `AGNO_ORG_EVENTS` | `agno.org.employee.>`, `agno.org.skill.>` | 30 days, 5 GiB | Module 02's own subjects (ADR-0019), previously unprovisioned too |
| `AGNO_ORG_DLQ` | `agno.org.dlq.>` | 180 days, 2 GiB | same reasoning as `AGNO_CORE_DLQ` |

All use `RetentionPolicy.Limits` + `StorageType.File` + `DiscardPolicy.Old`
(oldest messages evicted once a limit is hit - never silently unbounded).
The script is idempotent: it calls `streams.info(name)` first, only
`streams.add`-ing a stream that doesn't exist yet, and `streams.update`-ing
one whose subjects/`max_age`/`max_bytes` have drifted from the desired
config - safe to run repeatedly, including in CI/CD.

It is deliberately **not** invoked from `main.ts`/`NatsClientService`.
This repo already has an established precedent for exactly this kind of
one-time-per-environment provisioning step: `npm run migration:run` is a
separate, explicit command from `npm run start:dev`, never run implicitly
at boot. Stream provisioning follows the same shape - run once per target
environment (local dev, staging, prod) before that environment's outbox
publishers/batchers are expected to deliver anything, not on every process
start of every replica.

## Consequences
- Closes the readiness-checklist gap with actual runnable code, not just a
  documented deferral - `npm run nats:provision-streams` is now a real,
  idempotent step a deploy pipeline (or a local dev running
  `docker-compose up -d` for NATS) can call.
- If this script is never run against a given environment's NATS, every
  `NatsClientService.publish` call in that environment still fails exactly
  as it did before this ADR (JetStream rejects a publish to a subject no
  stream captures) - this ADR provisions the streams, it does not change
  what happens if provisioning is skipped. That failure is caught by the
  existing outbox/batcher retry-then-DLQ paths (ADR-0039/ADR-0042)
  regardless.
- Not addressed here: consumer-side configuration (durable consumer names,
  ack policies, `max_deliver`) for whatever eventually reads
  `AGNO_CORE_AUDIT`/`AGNO_ORG_EVENTS` - out of scope, since no consumer of
  these streams exists in this repo yet (see the Identity & Audit Console
  gap already noted in the Phase 5 readiness checklist).
- Retention numbers (30/90/180 days, byte caps) are reasoned defaults, not
  derived from a load test - flagged the same way every other capacity
  planning number in this repo's README is (no measured baseline exists
  yet to size against).
