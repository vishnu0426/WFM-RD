import { LlmCallFailedError } from './llm/llm-call-failed.error';

export interface ParsedNlAnalyticsTranslation {
  kind: 'metric_query' | 'executive_summary';
  metricName: string | null;
  orgUnitId: string | null;
  period: 'current_month' | 'last_month' | 'last_quarter' | null;
  selfReportedConfidence: number;
}

const VALID_PERIODS = new Set(['current_month', 'last_month', 'last_quarter']);

/**
 * ADR-0165: `translateQuestion`'s own parser, alongside `parseLlmExplanationResponse`
 * - a different response shape (a structured query, not a prose
 * explanation) needs its own validation, most importantly the one check
 * that isn't just "is this valid JSON": `metricName`, when present, must be
 * one of `availableMetricNames` - the prompt already instructs the model
 * never to invent one, but a prompt instruction is not a data-integrity
 * guarantee. Any shape violation (unknown "kind", a "metric_query" with no
 * real metricName, an "executive_summary" with an invalid "period") is
 * treated exactly like malformed JSON - `LlmCallFailedError`, routing the
 * caller into the same degraded-mode/`AnalyticsNlBridgeUnavailableError`
 * path a real provider outage would, never a silently-wrong translation.
 */
export function parseNlAnalyticsTranslation(
  rawText: string,
  availableMetricNames: readonly string[],
): ParsedNlAnalyticsTranslation {
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonText = fenceMatch ? fenceMatch[1] : rawText;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new LlmCallFailedError(new Error(`model response was not valid JSON: ${(err as Error).message}`));
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new LlmCallFailedError(new Error('model response was not a JSON object'));
  }
  const record = parsed as Record<string, unknown>;

  if (record.kind !== 'metric_query' && record.kind !== 'executive_summary') {
    throw new LlmCallFailedError(new Error(`model response had an invalid "kind": ${JSON.stringify(record.kind)}`));
  }

  const selfReportedConfidence =
    typeof record.selfReportedConfidence === 'number' ? record.selfReportedConfidence : 0.5;

  if (record.kind === 'metric_query') {
    const metricName = typeof record.metricName === 'string' ? record.metricName : null;
    if (!metricName || !availableMetricNames.includes(metricName)) {
      throw new LlmCallFailedError(
        new Error(`model response's "metricName" (${JSON.stringify(record.metricName)}) is not a known metric`),
      );
    }
    return { kind: 'metric_query', metricName, orgUnitId: null, period: null, selfReportedConfidence };
  }

  if (typeof record.period !== 'string' || !VALID_PERIODS.has(record.period)) {
    throw new LlmCallFailedError(
      new Error(`model response had an invalid "period" for executive_summary: ${JSON.stringify(record.period)}`),
    );
  }
  const orgUnitId = typeof record.orgUnitId === 'string' && record.orgUnitId.length > 0 ? record.orgUnitId : null;
  return {
    kind: 'executive_summary',
    metricName: null,
    orgUnitId,
    period: record.period as 'current_month' | 'last_month' | 'last_quarter',
    selfReportedConfidence,
  };
}
