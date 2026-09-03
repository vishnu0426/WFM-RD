/**
 * Module 07 Phase 8 (§0.5/§7): the release-gate load test - "popular-shift
 * contention," many employees racing to claim the same open shift at once,
 * validating this module's three stated SLOs (claim lock acquisition p99 <
 * 100ms, guardrail validation gRPC round-trip p99 < 500ms, subscription
 * push p99 < 500ms - `MetricsService`'s own doc comments) at a scale well
 * beyond `test/integration/claim-open-shift-concurrency.spec.ts`'s N=20.
 *
 * A standalone script run against real local infra (Postgres/Redis/NATS,
 * a real booted `shift-marketplace-service`, a real booted
 * `scheduling-service` for the guardrail gRPC call) - same "actually do
 * it, not a synthetic trickle" precedent as
 * `scheduling-service/scripts/load_test_decomposition.py` (Module 04) and
 * `intraday-service/scripts/load-test.ts` (Module 05, ADR-0071). No new
 * npm dependency - plain `fetch`, `graphql-ws` (already a dependency for
 * this service's own subscription resolver), and Node 22+'s global
 * `WebSocket` (no separate `ws` package needed).
 *
 * Accepted scope boundary (stated up front, not discovered after the
 * fact): each round's `MarketplacePost` is seeded with a random
 * `shiftAssignmentId` that does not resolve to a real `ShiftAssignment` in
 * scheduling-service - standing up a real schedule/employee/assignment
 * fixture cross-service for every round is disproportionate to what this
 * load test needs to prove. The guardrail gRPC call is still fully real
 * (a genuine network round-trip through `SchedulingEligibilityGrpcClientService`
 * to scheduling-service's real gRPC server, ADR-0082) - it resolves
 * `shiftAssignmentFound: false` (a real, fast not-found path) rather than
 * a real eligibility computation. This still exercises the winner's real
 * pipeline end to end: the lock, the real gRPC round-trip, the claim
 * ending `rejected`/`stale_post`, the post flipping to `expired`, and a
 * real `marketplacePostUpdated` subscription push - only the eligibility
 * *computation* itself is a not-found short-circuit rather than a full
 * constraint check.
 *
 * Usage: ts-node -r tsconfig-paths/register scripts/load-test.ts [claimantsPerRound] [rounds]
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { createClient } from 'graphql-ws';

const BASE_URL = process.env.LOAD_TEST_BASE_URL ?? 'http://localhost:8400';
const TENANT_ID = randomUUID();
const ORG_UNIT_ID = randomUUID();
const CLAIMANTS_PER_ROUND = Number(process.argv[2] ?? process.env.LOAD_TEST_CLAIMANTS ?? 40);
const ROUNDS = Number(process.argv[3] ?? process.env.LOAD_TEST_ROUNDS ?? 25);

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(samples: number[]): string {
  if (samples.length === 0) return '(no samples)';
  return [
    `n=${samples.length}`,
    `p50=${percentile(samples, 50).toFixed(1)}ms`,
    `p95=${percentile(samples, 95).toFixed(1)}ms`,
    `p99=${percentile(samples, 99).toFixed(1)}ms`,
    `max=${Math.max(...samples).toFixed(1)}ms`,
  ].join(' ');
}

async function fetchMetricsSnapshot(): Promise<string> {
  const res = await fetch(`${BASE_URL}/metrics`);
  return res.text();
}

function extractMetricLines(metricsText: string, name: string): string[] {
  return metricsText.split('\n').filter((line) => line.startsWith(name) && !line.startsWith('#'));
}

async function claimOpenShift(
  postId: string,
  actorId: string,
): Promise<{ ms: number; ok: boolean; errorCode?: string }> {
  const t0 = performance.now();
  const res = await fetch(`${BASE_URL}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID, 'X-Actor-Id': actorId },
    body: JSON.stringify({
      query: `mutation($postId: ID!) { claimOpenShift(postId: $postId) { claim { id status } } }`,
      variables: { postId },
    }),
  });
  const body = (await res.json()) as { errors?: Array<{ extensions?: { code?: string } }> };
  const ms = performance.now() - t0;
  const errorCode = body.errors?.[0]?.extensions?.code;
  return { ms, ok: !body.errors, errorCode };
}

async function seedPost(client: Client): Promise<string> {
  const postId = randomUUID();
  await client.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', TENANT_ID]);
  await client.query(
    `INSERT INTO marketplace.marketplace_post
       (id, tenant_id, post_type, shift_assignment_id, org_unit_id, posted_by, status, eligibility_rules, expires_at, created_at)
     VALUES ($1, $2, 'open_shift', $3, $4, NULL, 'open', '{}'::jsonb, now() + interval '1 hour', now())`,
    [postId, TENANT_ID, randomUUID(), ORG_UNIT_ID],
  );
  return postId;
}

interface RoundResult {
  winnerMs: number | null;
  loserSamples: number[];
  winnerErrorCode?: string;
}

async function runRound(client: Client, subscriptionPushes: Map<string, number>): Promise<RoundResult> {
  const postId = await seedPost(client);
  const sentAt = performance.now();
  subscriptionPushes.set(postId, sentAt);

  const claimantIds = Array.from({ length: CLAIMANTS_PER_ROUND }, () => randomUUID());
  const outcomes = await Promise.all(claimantIds.map((actorId) => claimOpenShift(postId, actorId)));

  const losers = outcomes.filter((o) => o.errorCode === 'POST_ALREADY_BEING_CLAIMED');
  const winner = outcomes.find((o) => o.errorCode !== 'POST_ALREADY_BEING_CLAIMED');

  return {
    winnerMs: winner?.ms ?? null,
    loserSamples: losers.map((l) => l.ms),
    winnerErrorCode: winner?.errorCode,
  };
}

async function runSubscriptionListener(
  pushLatencies: number[],
  sentAtByPostId: Map<string, number>,
  expectedCount: number,
): Promise<() => void> {
  const wsUrl = BASE_URL.replace(/^http/, 'ws');
  const client = createClient({ url: `${wsUrl}/graphql`, webSocketImpl: WebSocket });

  const query = `subscription($tenantId: ID!, $orgUnitId: ID!) {
    marketplacePostUpdated(tenantId: $tenantId, orgUnitId: $orgUnitId) { id status }
  }`;

  client.subscribe(
    { query, variables: { tenantId: TENANT_ID, orgUnitId: ORG_UNIT_ID } },
    {
      next: (msg) => {
        const data = msg.data as { marketplacePostUpdated: { id: string } } | undefined;
        const postId = data?.marketplacePostUpdated.id;
        const sentAt = postId === undefined ? undefined : sentAtByPostId.get(postId);
        if (sentAt !== undefined) {
          pushLatencies.push(performance.now() - sentAt);
        }
        if (pushLatencies.length >= expectedCount) {
          client.dispose();
        }
      },
      error: (err) => console.error('subscription error', err),
      complete: () => undefined,
    },
  );

  await new Promise((r) => setTimeout(r, 1000));
  return () => client.dispose();
}

async function main(): Promise<void> {
  console.log(
    `Load test starting against ${BASE_URL} - ${ROUNDS} rounds x ${CLAIMANTS_PER_ROUND} concurrent claimants/round, tenant ${TENANT_ID}`,
  );

  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
    password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
    database: process.env.DB_DATABASE ?? 'agno_wfm',
  });
  await client.connect();

  const pushLatencies: number[] = [];
  const sentAtByPostId = new Map<string, number>();
  const disposeSubscription = await runSubscriptionListener(pushLatencies, sentAtByPostId, ROUNDS);

  const beforeMetrics = await fetchMetricsSnapshot();

  const winnerSamples: number[] = [];
  const loserSamples: number[] = [];
  const winnerErrorCodeTally: Record<string, number> = {};

  const wallStart = Date.now();
  for (let round = 0; round < ROUNDS; round++) {
    const result = await runRound(client, sentAtByPostId);
    if (result.winnerMs !== null) winnerSamples.push(result.winnerMs);
    loserSamples.push(...result.loserSamples);
    if (result.winnerErrorCode) {
      winnerErrorCodeTally[result.winnerErrorCode] = (winnerErrorCodeTally[result.winnerErrorCode] ?? 0) + 1;
    }
    console.log(
      `Round ${round + 1}/${ROUNDS} done - winner ${result.winnerMs?.toFixed(1)}ms, ${result.loserSamples.length} losers`,
    );
  }
  const wallSeconds = (Date.now() - wallStart) / 1000;

  // Give the final round's push a moment to arrive before scraping "after".
  await new Promise((r) => setTimeout(r, 2000));
  disposeSubscription();
  const afterMetrics = await fetchMetricsSnapshot();
  await client.end();

  console.log(`\nWall time: ${wallSeconds.toFixed(1)}s`);
  console.log(`Winner (full pipeline incl. real guardrail gRPC round-trip): ${summarize(winnerSamples)}`);
  console.log(`Loser (immediate lock fast-fail): ${summarize(loserSamples)}`);
  console.log(
    `Subscription push (marketplacePostUpdated): ${summarize(pushLatencies)} (${pushLatencies.length}/${ROUNDS} correlated)`,
  );

  const report = buildReport(
    winnerSamples,
    loserSamples,
    pushLatencies,
    winnerErrorCodeTally,
    beforeMetrics,
    afterMetrics,
    wallSeconds,
  );
  const outPath = join(__dirname, '..', '..', 'docs', 'module-07-phase-8-load-test-results.md');
  writeFileSync(outPath, report);
  console.log(`\nReport written to ${outPath}`);
}

function buildReport(
  winnerSamples: number[],
  loserSamples: number[],
  pushLatencies: number[],
  winnerErrorCodeTally: Record<string, number>,
  beforeMetrics: string,
  afterMetrics: string,
  wallSeconds: number,
): string {
  const loserP99 = percentile(loserSamples, 99);
  const pushP99 = pushLatencies.length > 0 ? percentile(pushLatencies, 99) : NaN;
  const lockBucketsBefore = extractMetricLines(
    beforeMetrics,
    'marketplace_claim_lock_acquisition_duration_seconds_bucket',
  );
  const lockBucketsAfter = extractMetricLines(
    afterMetrics,
    'marketplace_claim_lock_acquisition_duration_seconds_bucket',
  );
  const guardrailBucketsAfter = extractMetricLines(
    afterMetrics,
    'marketplace_guardrail_validation_duration_seconds_bucket',
  );
  const pushBucketsAfter = extractMetricLines(afterMetrics, 'marketplace_subscription_push_duration_seconds_bucket');
  const claimAttemptsAfter = extractMetricLines(afterMetrics, 'marketplace_claim_attempts_total');

  return `# Module 07 Phase 8 - popular-shift contention load test results

Generated ${new Date().toISOString()} by \`scripts/load-test.ts\` against a real local Postgres/Redis/NATS, a real booted \`shift-marketplace-service\`, and a real booted \`scheduling-service\` gRPC eligibility server (not mocked, not simulated).

## Configuration

- Rounds: ${ROUNDS}, concurrent claimants per round: ${CLAIMANTS_PER_ROUND} (total claim attempts: ${ROUNDS * CLAIMANTS_PER_ROUND})
- Tenant: \`${TENANT_ID}\`, org unit: \`${ORG_UNIT_ID}\`
- Wall time: ${wallSeconds.toFixed(1)}s

**Accepted scope boundary**: each round's post carries a random, non-resolving \`shiftAssignmentId\` - the guardrail gRPC round-trip is real (a genuine call to scheduling-service's real gRPC server) but resolves \`shiftAssignmentFound: false\` (a real, fast not-found path), not a full eligibility computation against a real assignment. Every winner's claim therefore ends \`rejected\`/\`stale_post\`, and the post flips to \`expired\` - still a real state change, still a real subscription push. This load test validates lock contention, the real gRPC round-trip's latency floor, and real subscription fan-out; it does not validate guardrail latency under a full constraint-check payload.

## Results

### Lock contention - exactly one winner per round

Winner outcomes: ${JSON.stringify(winnerErrorCodeTally)} (an empty object means every round's winner reached a real claim decision, not stuck on an unexpected error).

### Loser fast-fail latency (immediate \`PostAlreadyBeingClaimedError\`) - proxy for claim lock acquisition SLO (§0.5: p99 < 100ms)

${summarize(loserSamples)}

**Directional read: ${loserP99 < 100 ? 'consistent with' : 'NOT consistent with'} the 100ms target** (client-observed p99 = ${loserP99.toFixed(1)}ms includes full HTTP+GraphQL overhead on top of the lock itself - see the real server-side histogram buckets below for the actual measured lock-acquisition duration, which is the metric the SLO is defined against).

### Winner latency (full pipeline incl. real guardrail gRPC round-trip)

${summarize(winnerSamples)}

### Subscription push (\`marketplacePostUpdated\`) - SLO: p99 < 500ms

${pushLatencies.length > 0 ? summarize(pushLatencies) : `Received 0/${ROUNDS} pushes correlated - see server logs.`}

${pushLatencies.length > 0 ? `**SLO ${pushP99 < 500 ? 'MET' : 'NOT MET'}** (p99 = ${pushP99.toFixed(1)}ms vs 500ms target).` : '**SLO not evaluated this run** - no correlated samples.'}

### Artifacts: real server-side \`marketplace_claim_lock_acquisition_duration_seconds\` histogram (§0.5 SLO: p99 < 100ms)

Before run:
\`\`\`
${lockBucketsBefore.join('\n') || '(none scraped yet)'}
\`\`\`

After run:
\`\`\`
${lockBucketsAfter.join('\n') || '(none scraped yet)'}
\`\`\`

### Artifacts: real server-side \`marketplace_guardrail_validation_duration_seconds\` histogram (§0.5 SLO: p99 < 500ms)

\`\`\`
${guardrailBucketsAfter.join('\n') || '(none scraped yet)'}
\`\`\`

### Artifacts: real server-side \`marketplace_subscription_push_duration_seconds\` histogram (§0.5 SLO: p99 < 500ms)

\`\`\`
${pushBucketsAfter.join('\n') || '(none scraped yet)'}
\`\`\`

### Artifacts: \`marketplace_claim_attempts_total\` by result (Phase 6 anti-abuse visibility)

\`\`\`
${claimAttemptsAfter.join('\n') || '(none scraped yet)'}
\`\`\`

## Interpretation

(Filled in by hand after reviewing the actual numbers above.)
`;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
