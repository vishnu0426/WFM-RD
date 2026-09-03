import { connect, nanos, RetentionPolicy, StorageType, DiscardPolicy, StreamConfig } from 'nats';

/**
 * §4's "define the actual retention policy, don't leave storage unbounded" -
 * the gap the Phase 5 readiness checklist flagged: `NatsClientService.publish`
 * (both Module 01's and Module 02's copies) assumes a JetStream stream
 * already exists server-side to capture each subject it publishes to,
 * but nothing in this repo provisioned one.
 *
 * Deliberately a standalone, explicit script - not something app boot runs
 * automatically - the same posture this repo already takes for schema
 * changes (`npm run migration:run` is a separate step from `npm run
 * start:dev`, never run implicitly at boot). Idempotent: safe to run again
 * against streams that already exist (updates config if it has drifted,
 * otherwise leaves it alone). Run via `npm run nats:provision-streams`
 * against a target environment's `NATS_URL` before that environment's
 * outbox publishers/batchers are expected to deliver anything.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

const STREAMS: Partial<StreamConfig>[] = [
  {
    name: 'AGNO_CORE_AUDIT',
    subjects: ['agno.core.audit.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_age: nanos(30 * DAY_MS),
    max_bytes: 5 * 1024 * 1024 * 1024,
    description: "Module 01 Phase 5 (§4): AuditEvent stream - core.outbox_events' published rows.",
  },
  {
    name: 'AGNO_CORE_POLICY',
    subjects: ['agno.core.policy.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_age: nanos(90 * DAY_MS),
    max_bytes: 1024 * 1024 * 1024,
    description: 'Module 01 Phase 4/5 (§4): PolicyChanged stream.',
  },
  {
    name: 'AGNO_CORE_DLQ',
    subjects: ['agno.core.dlq.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    // Dead letters need to survive long enough for someone to actually
    // triage them - longer retention than the streams they're a fallback for.
    max_age: nanos(180 * DAY_MS),
    max_bytes: 2 * 1024 * 1024 * 1024,
    description:
      "Module 01's dead-letter stream - CoreOutboxPublisherService/AuditEventBatcherService exhausted-retry events.",
  },
  {
    name: 'AGNO_ORG_EVENTS',
    subjects: ['agno.org.employee.>', 'agno.org.skill.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_age: nanos(30 * DAY_MS),
    max_bytes: 5 * 1024 * 1024 * 1024,
    description: 'Module 02 (ADR-0019): EmployeeChanged/SkillExpiring stream.',
  },
  {
    name: 'AGNO_ORG_DLQ',
    subjects: ['agno.org.dlq.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_age: nanos(180 * DAY_MS),
    max_bytes: 2 * 1024 * 1024 * 1024,
    description: "Module 02's dead-letter stream.",
  },
  {
    name: 'AGNO_INTRADAY_EVENTS',
    subjects: [
      'agno.intraday.agent.>',
      'agno.intraday.queue.>',
      'agno.intraday.reallocation.>',
      'agno.intraday.staffing_offer.>',
    ],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    // Module 05 Phase 1 (§0.5 FinOps ask - state the actual retention
    // window, don't leave it unbounded): 24h is enough for the Phase 2
    // consumer to catch back up after an outage and for short-window
    // replay/debugging, not an indefinite/audit retention - AdherenceEvent
    // (Postgres, Phase 3) is this module's actual durable history, not this
    // stream. `agent.state_changed` is by far the highest-volume subject
    // here (ADR-0063's per-employee-keyed suffix multiplies subject count,
    // not stream count), so this window is sized off that one, not the
    // lower-volume queue/reallocation subjects sharing the stream.
    max_age: nanos(1 * DAY_MS),
    max_bytes: 10 * 1024 * 1024 * 1024,
    description:
      'Module 05 Phase 1 (§4.3, ADR-0063): AgentStateChanged/QueueMetricsUpdated/ReallocationSuggested/StaffingOfferCreated stream.',
  },
  {
    name: 'AGNO_INTRADAY_DLQ',
    subjects: ['agno.intraday.dlq.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_age: nanos(180 * DAY_MS),
    max_bytes: 2 * 1024 * 1024 * 1024,
    description:
      "Module 05's dead-letter stream - not yet published to in this phase (no consumer/retry logic exists until Phase 2).",
  },
  {
    name: 'AGNO_ATTENDANCE_LEAVE_EVENTS',
    subjects: ['agno.leave.request.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    // Module 06 Phase 5 (§3.4, ADR-0078): LeaveRequestApproved stream - the
    // push half of the propagation design. 90 days matches Module 01's own
    // PolicyChanged retention (a comparable low-volume, audit-adjacent
    // event stream, not a high-frequency telemetry one like intraday's).
    max_age: nanos(90 * DAY_MS),
    max_bytes: 1024 * 1024 * 1024,
    description: 'Module 06 Phase 5 (§3.4, ADR-0078): LeaveRequestApproved stream.',
  },
  {
    name: 'AGNO_ATTENDANCE_LEAVE_DLQ',
    subjects: ['agno.leave.dlq.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_age: nanos(180 * DAY_MS),
    max_bytes: 2 * 1024 * 1024 * 1024,
    description:
      "Module 06's dead-letter stream - not yet published to (no consumer/retry logic exists yet; the publisher itself is best-effort, ADR-0078).",
  },
  {
    name: 'AGNO_MARKETPLACE_EVENTS',
    subjects: ['agno.marketplace.claim.>', 'agno.marketplace.swap.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    // Module 07 Phase 5 (ADR-0089): ShiftClaimApproved/SwapExecuted - the
    // handoff scheduling-service's NATS consumer applies to
    // `scheduling.shift_assignments`. 90 days matches Module 01/06's own
    // audit-adjacent, low-volume event retention (a marketplace approval is
    // nowhere near intraday's telemetry-grade volume).
    max_age: nanos(90 * DAY_MS),
    max_bytes: 1024 * 1024 * 1024,
    description:
      "Module 07 Phase 5 (ADR-0089): ShiftClaimApproved/SwapExecuted stream - scheduling-service is this stream's first-ever consumer.",
  },
  {
    name: 'AGNO_MARKETPLACE_DLQ',
    subjects: ['agno.marketplace.dlq.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_age: nanos(180 * DAY_MS),
    max_bytes: 2 * 1024 * 1024 * 1024,
    description:
      "Module 07's dead-letter stream - scheduling-service's marketplace consumer terms an unparseable/permanently-invalid event here rather than redelivering it forever.",
  },
  {
    name: 'AGNO_AI_LAYER_EVENTS',
    subjects: ['agno.ai.recommendation.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    // Module 10 §4/§8.1 event backbone: AIRecommendationCreated/
    // AIRecommendationDecided - Module 01 audit consumption plus any module
    // awaiting a decided recommendation. Not published to yet (Phase 5
    // builds AIRecommendation creation/decision) - provisioned now, same
    // "declared before its first real publisher exists" posture Module 05's
    // own AGNO_INTRADAY_DLQ took. 90 days matches Module 01/06/07's own
    // audit-adjacent, low-volume event retention - an AIRecommendation
    // decision is nowhere near intraday's telemetry-grade volume.
    max_age: nanos(90 * DAY_MS),
    max_bytes: 1024 * 1024 * 1024,
    description:
      'Module 10 (§4/§8.1): AIRecommendationCreated/AIRecommendationDecided stream - not yet published to (Phase 5).',
  },
  {
    name: 'AGNO_AI_LAYER_DLQ',
    subjects: ['agno.ai.dlq.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_age: nanos(180 * DAY_MS),
    max_bytes: 2 * 1024 * 1024 * 1024,
    description:
      "Module 10's dead-letter stream - not yet published to (no publisher/retry logic exists until Phase 5).",
  },
  {
    name: 'AGNO_INTEGRATION_HUB_EVENTS',
    subjects: ['agno.integration_hub.sync_job.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    // Module 12 Phase 7 (ADR-0144): SyncJobCompleted - published from
    // `SyncJobsService.complete()`, the single convergence point every
    // real `SyncJob` completion (batch or streaming) already funnels
    // through, immediately followed by this module's own webhook fan-out
    // (ADR-0046's fan-out-right-after-publish shape, reused a fourth
    // time). 90 days matches Module 01/06/07/10's own audit-adjacent, low-
    // volume event retention - a sync completion is nowhere near
    // intraday's telemetry-grade volume.
    max_age: nanos(90 * DAY_MS),
    max_bytes: 1024 * 1024 * 1024,
    description: 'Module 12 Phase 7 (ADR-0144): SyncJobCompleted stream.',
  },
  {
    name: 'AGNO_INTEGRATION_HUB_DLQ',
    subjects: ['agno.integration_hub.dlq.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_age: nanos(180 * DAY_MS),
    max_bytes: 2 * 1024 * 1024 * 1024,
    description:
      "Module 12's dead-letter stream - not yet published to (no consumer/retry logic exists yet; the publisher itself is best-effort, own copy of every prior module's identical DLQ note).",
  },
];

async function main(): Promise<void> {
  const url = process.env.NATS_URL ?? 'nats://localhost:4222';
  // eslint-disable-next-line no-console
  console.log(`Connecting to NATS at ${url} ...`);
  const conn = await connect({ servers: url, timeout: 5000 });
  const jsm = await conn.jetstreamManager();

  const results: string[] = [];
  for (const cfg of STREAMS) {
    const name = cfg.name!;
    try {
      const existing = await jsm.streams.info(name);
      const changed =
        JSON.stringify(existing.config.subjects) !== JSON.stringify(cfg.subjects) ||
        existing.config.max_age !== cfg.max_age ||
        existing.config.max_bytes !== cfg.max_bytes;
      if (changed) {
        await jsm.streams.update(name, cfg);
        results.push(`updated  ${name} (config drifted from desired state)`);
      } else {
        results.push(`ok       ${name} (already provisioned, no change)`);
      }
    } catch {
      // streams.info throws "stream not found" (404) when it doesn't exist yet.
      await jsm.streams.add(cfg);
      results.push(`created  ${name}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(results.join('\n'));
  await conn.drain();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('nats:provision-streams FAILED:', err);
  process.exitCode = 1;
});
