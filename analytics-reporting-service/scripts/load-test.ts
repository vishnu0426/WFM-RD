/**
 * Module 09 Phase 8 (§0.5/§7, ADR-0112): the release-gate load test for this
 * module's own read path - `metricQuery`/`executiveSummary` GraphQL calls
 * against a real booted `analytics-reporting-service`, real local Postgres
 * (primary + streaming replica), checked against the only numeric latency
 * figures this module's own spec ever committed to:
 * `MetricValidationService`'s own `CHEAP_THRESHOLD_MS` (100ms) /
 * `MODERATE_THRESHOLD_MS` (1000ms) cost-tier bands. This module never had
 * an explicit §0.5 p99 target the way Module 05/07 did - those two
 * thresholds are the honest stand-in, since they're the one place this
 * module's own code already commits to a number.
 *
 * Same "standalone script, real local infra, no new npm dependency"
 * precedent as `scheduling-service/scripts/load_test_decomposition.py`
 * (Module 04), `intraday-service/scripts/load-test.ts` (Module 05,
 * ADR-0071), and `shift-marketplace-service/scripts/load-test.ts`
 * (Module 07, ADR-0092) - plain `fetch`, no new dependency.
 *
 * Two rounds:
 * 1. Concurrent `metricQuery`/`executiveSummary` reads against the 6
 *    Phase-4-seeded platform-default metrics for a real tenant with real
 *    upserted rows (from this build's own prior-phase verification data) -
 *    the module's actual everyday read path.
 * 2. A smaller concurrent burst of `POST /v1/analytics/exports` (Phase 6's
 *    fire-and-forget async job), polled to completion, measuring end-to-end
 *    completion latency - `EXPORT_MAX_ROWS = 10,000`'s own disclosed-
 *    placeholder status is NOT validated at that row count here (this
 *    build's real data is a few dozen rows at most, see the results doc's
 *    own Interpretation section for why that gap is named, not silently
 *    closed).
 *
 * Usage: ts-node -r tsconfig-paths/register scripts/load-test.ts [concurrency] [rounds]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.LOAD_TEST_BASE_URL ?? 'http://localhost:8600';
const TENANT_ID = process.env.LOAD_TEST_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
const CONCURRENCY = Number(process.argv[2] ?? process.env.LOAD_TEST_CONCURRENCY ?? 50);
const ROUNDS = Number(process.argv[3] ?? process.env.LOAD_TEST_ROUNDS ?? 10);
const EXPORT_CONCURRENCY = 10;

const METRIC_NAMES = [
  'adherence_trend',
  'forecast_accuracy_mape',
  'scheduled_hours',
  'overtime_hours',
  'approved_leave_days',
  'attrition_terminations',
];

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

async function graphqlRequest(query: string, variables: Record<string, unknown>): Promise<{ ms: number; ok: boolean }> {
  const t0 = performance.now();
  const res = await fetch(`${BASE_URL}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { errors?: unknown[] };
  const ms = performance.now() - t0;
  return { ms, ok: !body.errors };
}

async function metricQueryOnce(metricName: string): Promise<{ ms: number; ok: boolean }> {
  return graphqlRequest(
    `query($metricName: String!) { metricQuery(metricName: $metricName) { metric value } }`,
    { metricName },
  );
}

async function executiveSummaryOnce(): Promise<{ ms: number; ok: boolean }> {
  return graphqlRequest(
    `query($period: ExecutiveSummaryPeriod!) { executiveSummary(period: $period) { metric value } }`,
    { period: 'CURRENT_MONTH' },
  );
}

async function runReadRound(): Promise<{ ms: number; ok: boolean }[]> {
  const calls: Promise<{ ms: number; ok: boolean }>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const metricName = METRIC_NAMES[i % METRIC_NAMES.length];
    calls.push(i % 4 === 0 ? executiveSummaryOnce() : metricQueryOnce(metricName));
  }
  return Promise.all(calls);
}

interface ExportOutcome {
  requestMs: number;
  completionMs: number | null;
  finalStatus: string;
}

async function runExportOnce(): Promise<ExportOutcome> {
  const t0 = performance.now();
  const res = await fetch(`${BASE_URL}/v1/analytics/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT_ID, 'X-Actor-Id': TENANT_ID },
    body: JSON.stringify({ metricName: 'adherence_trend', filter: {} }),
  });
  const requestMs = performance.now() - t0;
  const { id } = (await res.json()) as { id: string };

  const pollStart = performance.now();
  for (let attempt = 0; attempt < 50; attempt++) {
    const pollRes = await fetch(`${BASE_URL}/v1/analytics/exports/${id}`, {
      headers: { 'X-Tenant-Id': TENANT_ID, 'X-Actor-Id': TENANT_ID },
    });
    const pollBody = (await pollRes.json()) as { status: string };
    if (pollBody.status === 'completed' || pollBody.status === 'failed') {
      return { requestMs, completionMs: performance.now() - pollStart, finalStatus: pollBody.status };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { requestMs, completionMs: null, finalStatus: 'timed_out_polling' };
}

async function main(): Promise<void> {
  console.log(
    `Load test starting against ${BASE_URL} - ${ROUNDS} rounds x ${CONCURRENCY} concurrent reads/round, tenant ${TENANT_ID}`,
  );

  const beforeMetrics = await fetchMetricsSnapshot();

  const readLatencies: number[] = [];
  let readFailures = 0;
  const wallStart = Date.now();
  for (let round = 0; round < ROUNDS; round++) {
    const results = await runReadRound();
    for (const r of results) {
      readLatencies.push(r.ms);
      if (!r.ok) readFailures++;
    }
    console.log(`Read round ${round + 1}/${ROUNDS} done - ${summarize(results.map((r) => r.ms))}`);
  }
  const readWallSeconds = (Date.now() - wallStart) / 1000;

  console.log(`\nExport burst: ${EXPORT_CONCURRENCY} concurrent POST /v1/analytics/exports`);
  const exportOutcomes = await Promise.all(Array.from({ length: EXPORT_CONCURRENCY }, () => runExportOnce()));
  const exportRequestLatencies = exportOutcomes.map((o) => o.requestMs);
  const exportCompletionLatencies = exportOutcomes
    .map((o) => o.completionMs)
    .filter((ms): ms is number => ms !== null);
  const exportStatusTally: Record<string, number> = {};
  for (const o of exportOutcomes) {
    exportStatusTally[o.finalStatus] = (exportStatusTally[o.finalStatus] ?? 0) + 1;
  }

  const afterMetrics = await fetchMetricsSnapshot();

  console.log(`\nWall time (read rounds): ${readWallSeconds.toFixed(1)}s`);
  console.log(`Read latency (metricQuery + executiveSummary, mixed): ${summarize(readLatencies)}`);
  console.log(`Read failures: ${readFailures}/${readLatencies.length}`);
  console.log(`Export request-accepted latency: ${summarize(exportRequestLatencies)}`);
  console.log(`Export completion latency: ${summarize(exportCompletionLatencies)}`);
  console.log(`Export final status tally: ${JSON.stringify(exportStatusTally)}`);

  const report = buildReport(
    readLatencies,
    readFailures,
    readWallSeconds,
    exportRequestLatencies,
    exportCompletionLatencies,
    exportStatusTally,
    beforeMetrics,
    afterMetrics,
  );
  const outPath = join(__dirname, '..', '..', 'docs', 'module-09-phase-8-load-test-results.md');
  writeFileSync(outPath, report);
  console.log(`\nReport written to ${outPath}`);
}

function buildReport(
  readLatencies: number[],
  readFailures: number,
  readWallSeconds: number,
  exportRequestLatencies: number[],
  exportCompletionLatencies: number[],
  exportStatusTally: Record<string, number>,
  beforeMetrics: string,
  afterMetrics: string,
): string {
  const readP99 = percentile(readLatencies, 99);
  const httpBucketsAfter = extractMetricLines(afterMetrics, 'http_request_duration_seconds_bucket');
  const metricQueriesAfter = extractMetricLines(afterMetrics, 'analytics_metric_queries_total');
  const exportsAfter = extractMetricLines(afterMetrics, 'analytics_exports_total');
  const replicaLagAfter = extractMetricLines(afterMetrics, 'analytics_replica_lag_seconds');
  const consistencyAfter = extractMetricLines(afterMetrics, 'analytics_consistency_check_discrepancies_total');

  return `# Module 09 Phase 8 - read-path load test results

Generated ${new Date().toISOString()} by \`scripts/load-test.ts\` against a real local Postgres primary + a real streaming physical replica, and a real booted \`analytics-reporting-service\` (not mocked, not simulated).

## Configuration

- Rounds: ${ROUNDS}, concurrent reads per round: ${CONCURRENCY} (total read requests: ${ROUNDS * CONCURRENCY}), mixed \`metricQuery\` (6 Phase-4 platform-default metrics) and \`executiveSummary\`.
- Export burst: ${EXPORT_CONCURRENCY} concurrent \`POST /v1/analytics/exports\` requests, each polled to a terminal status.
- Tenant: \`${TENANT_ID}\` (real tenant with real upserted mv_* rows from this build's own prior-phase verification - a few dozen rows at most, not a synthetic large dataset).
- Wall time (read rounds): ${readWallSeconds.toFixed(1)}s

**Accepted scope boundary**: this module never had an explicit §0.5 numeric read-latency SLO the way Module 05/07 did. The one number this module's own code already commits to is \`MetricValidationService\`'s cost-tier banding (\`CHEAP_THRESHOLD_MS = 100\`, \`MODERATE_THRESHOLD_MS = 1000\`) - used here as the honest stand-in target, not a target this build was explicitly given. Real data volume is small (a few dozen rows per view, from prior phases' own live verification) - this proves the read path's latency floor under real concurrency, not its behavior against a production-scale dataset (no load-testing tool anywhere in this platform generates synthetic bulk fixtures at that scale either - see ADR-0112).

## Results

### Read latency (\`metricQuery\`/\`executiveSummary\`, mixed, client-observed)

${summarize(readLatencies)}

Failures: ${readFailures}/${readLatencies.length}

**Directional read: ${readP99 < 100 ? 'within the CHEAP_THRESHOLD_MS (100ms) band' : readP99 < 1000 ? 'within the MODERATE_THRESHOLD_MS (1000ms) band, not the CHEAP band' : 'NOT within either disclosed cost-tier band'}** at this concurrency and data volume (client-observed p99 = ${readP99.toFixed(1)}ms includes full HTTP+GraphQL overhead; see the real server-side \`http_request_duration_seconds\` histogram below for the number actually comparable to a server-side SLO).

### Export request-accepted latency (\`POST /v1/analytics/exports\` returning \`pending\`)

${summarize(exportRequestLatencies)}

### Export completion latency (accept to \`completed\`/\`failed\`, polled)

${exportCompletionLatencies.length > 0 ? summarize(exportCompletionLatencies) : '(no completions observed within the polling window)'}

Final status tally: ${JSON.stringify(exportStatusTally)}

### Artifacts: real server-side \`http_request_duration_seconds\` histogram (after run)

\`\`\`
${httpBucketsAfter.join('\n') || '(none scraped)'}
\`\`\`

### Artifacts: \`analytics_metric_queries_total\` by cost_tier/result (after run)

\`\`\`
${metricQueriesAfter.join('\n') || '(none scraped)'}
\`\`\`

### Artifacts: \`analytics_exports_total\` by result (after run)

\`\`\`
${exportsAfter.join('\n') || '(none scraped)'}
\`\`\`

### Artifacts: \`analytics_replica_lag_seconds\` (after run)

\`\`\`
${replicaLagAfter.join('\n') || '(none scraped - see MvFreshnessMonitorService doc comment on unlabeled-Gauge-defaults-to-0 behavior)'}
\`\`\`

### Artifacts: \`analytics_consistency_check_discrepancies_total\` (after run - reflects the last scheduled tick, not this load test)

\`\`\`
${consistencyAfter.join('\n') || '(no discrepancies recorded by the last consistency-check tick)'}
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
