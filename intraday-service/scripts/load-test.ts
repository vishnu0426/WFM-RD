/**
 * Module 05 Phase 7 (§0.5/§7): the release-gate load test - "100k+
 * concurrent agents generating state changes at realistic frequency,"
 * validating the three stated SLOs (ingestion p99 < 100ms,
 * `queueLiveStateUpdated` push p99 < 500ms, REST snapshot p99 < 200ms),
 * with Redis write throughput / NATS consumer lag recorded as artifacts.
 *
 * A standalone script run against real local infra (Redis/NATS/Postgres,
 * a real booted `intraday-service`), not mocked - same "actually do it,
 * not a synthetic trickle" precedent as
 * `scheduling-service/scripts/load_test_decomposition.py` (Module 04
 * Phase 7). No new npm dependency - bounded-concurrency `fetch` calls and
 * the `nats`/`graphql-ws`/`ws` packages already used throughout this
 * service's own phase-by-phase verification scripts.
 *
 * Ingestion's SLO ("webhook receipt to Redis write") is measured as this
 * endpoint's own HTTP round-trip time, matching `MetricsService`'s own
 * doc-comment interpretation (`intraday_ingestion_events_total`'s help
 * text ties the SLO to this endpoint, not a more complex async
 * "time until Redis actually reflects it" measurement) - see ADR-0071.
 *
 * Usage: ts-node -r tsconfig-paths/register scripts/load-test.ts [employeeCount]
 */
import { createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from 'graphql-ws';
import { connect, StringCodec } from 'nats';
import WebSocket from 'ws';

const BASE_URL = process.env.LOAD_TEST_BASE_URL ?? 'http://localhost:8200';
const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const WEBHOOK_SECRET = 'dev-secret-tenant-1';
const EMPLOYEE_COUNT = Number(process.argv[2] ?? process.env.LOAD_TEST_EMPLOYEES ?? 100_000);
const INGESTION_CONCURRENCY = 150;
const SNAPSHOT_REQUEST_COUNT = 2000;
const SNAPSHOT_CONCURRENCY = 100;
const SUBSCRIPTION_PUSH_COUNT = 500;

interface Sample {
  ms: number;
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(label: string, samples: number[]): string {
  return [
    `${label}: n=${samples.length}`,
    `  p50=${percentile(samples, 50).toFixed(1)}ms`,
    `  p95=${percentile(samples, 95).toFixed(1)}ms`,
    `  p99=${percentile(samples, 99).toFixed(1)}ms`,
    `  max=${Math.max(...samples).toFixed(1)}ms`,
  ].join('\n');
}

async function runPool<T>(count: number, concurrency: number, work: (i: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(count);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= count) return;
      results[i] = await work(i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function signBody(body: string): string {
  const timestamp = Date.now();
  const hmac = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

async function fetchMetricsSnapshot(): Promise<string> {
  const res = await fetch(`${BASE_URL}/metrics`);
  return res.text();
}

function extractMetricLines(metricsText: string, name: string): string[] {
  return metricsText.split('\n').filter((line) => line.startsWith(name) && !line.startsWith('#'));
}

async function runIngestionLoad(): Promise<number[]> {
  console.log(`\n=== Ingestion load: ${EMPLOYEE_COUNT} employees, concurrency ${INGESTION_CONCURRENCY} ===`);
  const startedAt = Date.now();
  const samples = await runPool(EMPLOYEE_COUNT, INGESTION_CONCURRENCY, async (i) => {
    const employeeId = randomUUID();
    const body = JSON.stringify({
      sourceEventId: `load-test-${i}-${randomUUID()}`,
      employeeId,
      currentActivity: 'available',
      activityStartedAt: new Date().toISOString(),
    });
    const signature = signBody(body);
    const t0 = performance.now();
    const res = await fetch(`${BASE_URL}/v1/intraday/tenants/${TENANT_ID}/activity-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agno-webhook-signature': signature },
      body,
    });
    const elapsed = performance.now() - t0;
    if (!res.ok) {
      console.error(`request ${i} failed: ${res.status} ${await res.text()}`);
    }
    return elapsed;
  });
  const wallSeconds = (Date.now() - startedAt) / 1000;
  console.log(`Wall time: ${wallSeconds.toFixed(1)}s (${(EMPLOYEE_COUNT / wallSeconds).toFixed(0)} req/s achieved)`);
  console.log(summarize('Ingestion round-trip latency', samples));
  return samples;
}

async function runSnapshotLoad(queueId: string): Promise<number[]> {
  console.log(`\n=== REST snapshot load: ${SNAPSHOT_REQUEST_COUNT} requests, concurrency ${SNAPSHOT_CONCURRENCY} ===`);
  const samples = await runPool(SNAPSHOT_REQUEST_COUNT, SNAPSHOT_CONCURRENCY, async () => {
    const t0 = performance.now();
    await fetch(`${BASE_URL}/v1/intraday/queues/${queueId}/live`, {
      headers: { 'X-Tenant-Id': TENANT_ID },
    });
    return performance.now() - t0;
  });
  console.log(summarize('REST snapshot latency', samples));
  return samples;
}

async function runSubscriptionFanoutLoad(queueId: string): Promise<number[]> {
  console.log(`\n=== Subscription fan-out load: ${SUBSCRIPTION_PUSH_COUNT} pushes ===`);
  const wsUrl = BASE_URL.replace(/^http/, 'ws');
  const client = createClient({ url: `${wsUrl}/graphql`, webSocketImpl: WebSocket });

  // `currentVolume` carries the send-side sequence number - the one field
  // already on `QueueLiveState` that can round-trip an integer, avoiding a
  // wider GraphQL selection set than a real client would ever request.
  const sendTimes = new Map<number, number>();
  const latencies: number[] = [];

  const query = `subscription($queueId: ID!) {
    queueLiveStateUpdated(queueId: $queueId) { queueId currentVolume }
  }`;

  const done = new Promise<void>((resolve) => {
    client.subscribe(
      { query, variables: { queueId } },
      {
        next: (msg) => {
          const data = msg.data as { queueLiveStateUpdated: { currentVolume: number } } | undefined;
          const seq = data?.queueLiveStateUpdated.currentVolume;
          const sentAt = seq === undefined ? undefined : sendTimes.get(seq);
          if (sentAt !== undefined) {
            latencies.push(performance.now() - sentAt);
          }
          if (latencies.length >= SUBSCRIPTION_PUSH_COUNT) resolve();
        },
        error: (err) => {
          console.error('subscription error', err);
          resolve();
        },
        complete: () => resolve(),
      },
    );
  });

  // Give the subscription a moment to actually establish before publishing.
  await new Promise((r) => setTimeout(r, 1000));

  const nc = await connect({ servers: NATS_URL });
  const js = nc.jetstream();
  const sc = StringCodec();

  for (let i = 0; i < SUBSCRIPTION_PUSH_COUNT; i++) {
    sendTimes.set(i, performance.now());
    await js.publish(
      'agno.intraday.queue.metrics_updated.v1',
      sc.encode(
        JSON.stringify({
          tenantId: TENANT_ID,
          queueId,
          currentVolume: i,
          agentsAvailable: 1,
          agentsOnCall: 1,
          forecastedVolume: 1,
          serviceLevelCurrent: 0.9,
          serviceLevelTarget: 0.8,
        }),
      ),
    );
  }

  await Promise.race([done, new Promise((r) => setTimeout(r, 30_000))]);
  await nc.close();
  client.dispose();

  console.log(`Received ${latencies.length}/${SUBSCRIPTION_PUSH_COUNT} pushes.`);
  if (latencies.length > 0) {
    console.log(summarize('Subscription fan-out latency', latencies));
  }
  return latencies;
}

async function main(): Promise<void> {
  console.log(`Load test starting against ${BASE_URL} - ${new Date().toISOString()}`);

  const queueId = randomUUID();
  // Seed the queue so the REST snapshot / subscription sections have a
  // real live queue to read - not part of the measured ingestion load.
  const nc = await connect({ servers: NATS_URL });
  const js = nc.jetstream();
  const sc = StringCodec();
  await js.publish(
    'agno.intraday.queue.metrics_updated.v1',
    sc.encode(
      JSON.stringify({
        tenantId: TENANT_ID,
        queueId,
        currentVolume: 10,
        agentsAvailable: 5,
        agentsOnCall: 3,
        forecastedVolume: 10,
        serviceLevelCurrent: 0.9,
        serviceLevelTarget: 0.8,
      }),
    ),
  );
  await nc.close();
  await new Promise((r) => setTimeout(r, 2000));

  const beforeMetrics = await fetchMetricsSnapshot();

  const ingestionSamples = await runIngestionLoad();
  const snapshotSamples = await runSnapshotLoad(queueId);
  const subscriptionSamples = await runSubscriptionFanoutLoad(queueId);

  await new Promise((r) => setTimeout(r, 3000));
  const afterMetrics = await fetchMetricsSnapshot();

  const report = buildReport(queueId, ingestionSamples, snapshotSamples, subscriptionSamples, beforeMetrics, afterMetrics);
  const outPath = join(__dirname, '..', '..', 'docs', 'module-05-phase-7-load-test-results.md');
  writeFileSync(outPath, report);
  console.log(`\nReport written to ${outPath}`);
}

function buildReport(
  queueId: string,
  ingestionSamples: number[],
  snapshotSamples: number[],
  subscriptionSamples: number[],
  beforeMetrics: string,
  afterMetrics: string,
): string {
  const ingestionP99 = percentile(ingestionSamples, 99);
  const snapshotP99 = percentile(snapshotSamples, 99);
  const subscriptionP99 = subscriptionSamples.length > 0 ? percentile(subscriptionSamples, 99) : NaN;
  const redisOpLines = extractMetricLines(afterMetrics, 'intraday_redis_operation_duration_seconds_bucket');
  const lagLinesBefore = extractMetricLines(beforeMetrics, 'intraday_nats_consumer_lag');
  const lagLinesAfter = extractMetricLines(afterMetrics, 'intraday_nats_consumer_lag');

  return `# Module 05 Phase 7 - Redis degradation / load test results

Generated ${new Date().toISOString()} by \`scripts/load-test.ts\` against a real local Redis/NATS/Postgres and a real booted \`intraday-service\` (not mocked, not simulated).

## Configuration

- Employees (ingestion): ${EMPLOYEE_COUNT}, concurrency ${INGESTION_CONCURRENCY}
- REST snapshot requests: ${SNAPSHOT_REQUEST_COUNT}, concurrency ${SNAPSHOT_CONCURRENCY}
- Subscription pushes: ${SUBSCRIPTION_PUSH_COUNT}
- Tenant: \`${TENANT_ID}\`, queue under test: \`${queueId}\`

## Results

### Ingestion (\`POST /v1/intraday/tenants/:tenantId/activity-events\`) - SLO: p99 < 100ms

${summarize('', ingestionSamples).trim()}

**SLO ${ingestionP99 < 100 ? 'MET' : 'NOT MET'}** (p99 = ${ingestionP99.toFixed(1)}ms vs 100ms target).

### REST snapshot (\`GET /v1/intraday/queues/:queueId/live\`) - SLO: p99 < 200ms

${summarize('', snapshotSamples).trim()}

**SLO ${snapshotP99 < 200 ? 'MET' : 'NOT MET'}** (p99 = ${snapshotP99.toFixed(1)}ms vs 200ms target).

### Subscription fan-out (\`queueLiveStateUpdated\`) - SLO: p99 < 500ms

${subscriptionSamples.length > 0 ? summarize('', subscriptionSamples).trim() : `Received 0/${SUBSCRIPTION_PUSH_COUNT} pushes correlated - see server logs for why (e.g. subscription failed to establish).`}

${
  subscriptionSamples.length > 0
    ? `**SLO ${subscriptionP99 < 500 ? 'MET' : 'NOT MET'}** (p99 = ${subscriptionP99.toFixed(1)}ms vs 500ms target, ${subscriptionSamples.length}/${SUBSCRIPTION_PUSH_COUNT} pushes received and correlated).`
    : '**SLO not evaluated this run** - no correlated samples.'
}

### Artifacts: Redis operation latency (post-run \`/metrics\` scrape)

\`\`\`
${redisOpLines.join('\n') || '(no samples - check server logs)'}
\`\`\`

### Artifacts: NATS consumer lag (\`intraday_nats_consumer_lag\`)

Before run:
\`\`\`
${lagLinesBefore.join('\n') || '(none scraped yet)'}
\`\`\`

After run:
\`\`\`
${lagLinesAfter.join('\n') || '(none scraped yet)'}
\`\`\`

## Interpretation

(Filled in by hand after reviewing the actual numbers above - see the
design doc's own Verification section for the full narrative.)
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
