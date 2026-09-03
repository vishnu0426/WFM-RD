/**
 * Phase 7 (§1's observability requirement, ADR-0050): OpenTelemetry span
 * wiring, deferred by name since Phase 2's own design doc ("OpenTelemetry
 * span wiring, SLO dashboards, chaos/game-day exercises (Phase 7)").
 *
 * Must be imported before anything else in `main.ts` (and before
 * `reflect-metadata`/Nest bootstrap) - OTel's auto-instrumentation patches
 * `http`, `express`, `pg`, and `ioredis` by hooking `require()` itself;
 * any of those modules already loaded before `sdk.start()` runs would be
 * un-instrumented for the lifetime of the process. This is the standard,
 * documented Node.js OTel SDK constraint, not a stylistic choice.
 *
 * No-op-safe by default: if `OTEL_EXPORTER_OTLP_ENDPOINT` is unset (true
 * for local dev and this repo's CI), spans are still generated and
 * processed in-process but never exported anywhere - `NodeSDK` doesn't
 * require a reachable collector to start cleanly. Point
 * `OTEL_EXPORTER_OTLP_ENDPOINT` at a real OTLP collector (Grafana Tempo,
 * Jaeger, a vendor collector, ...) to actually ship spans anywhere.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'agno-wfm-platform-core',
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
  }),
  traceExporter: otlpEndpoint ? new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }) : undefined,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Health/metrics scrapes are noise, not a business transaction -
      // excluded so they don't pollute trace volume or SLO panels built
      // from span data.
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) => req.url === '/healthz' || req.url === '/readyz' || req.url === '/metrics',
      },
    }),
  ],
});

try {
  sdk.start();
} catch (err) {
  // Tracing must never be why the app fails to boot - log and continue
  // un-instrumented rather than crash-looping over an observability
  // concern (§1: observability degrades gracefully, it is not a hard
  // dependency for correctness or availability).
  // eslint-disable-next-line no-console
  console.error('OpenTelemetry SDK failed to start - continuing without tracing:', err);
}

process.on('SIGTERM', () => {
  sdk.shutdown().catch(() => undefined);
});
