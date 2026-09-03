/**
 * Must be the very first import in `main.ts`, before `reflect-metadata` and
 * before anything else - identical constraint and rationale as every other
 * service's `tracing.ts` in this platform: OTel auto-instrumentation
 * patches `http`/`express`/`pg` by hooking `require()` itself, so any of
 * those modules already loaded before `sdk.start()` runs would stay
 * un-instrumented for the process's lifetime.
 *
 * No-op-safe by default: with `OTEL_EXPORTER_OTLP_ENDPOINT` unset (local dev
 * default), spans are generated but never exported.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'agno-wfm-analytics-reporting-service',
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
  }),
  traceExporter: otlpEndpoint ? new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }) : undefined,
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) => req.url === '/healthz' || req.url === '/readyz' || req.url === '/metrics',
      },
    }),
  ],
});

try {
  sdk.start();
} catch (err) {
  // Tracing must never be why the app fails to boot.
  // eslint-disable-next-line no-console
  console.error('OpenTelemetry SDK failed to start - continuing without tracing:', err);
}

process.on('SIGTERM', () => {
  sdk.shutdown().catch(() => undefined);
});
