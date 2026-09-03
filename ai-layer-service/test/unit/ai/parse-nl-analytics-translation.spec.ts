import { parseNlAnalyticsTranslation } from '../../../src/ai/parse-nl-analytics-translation';
import { LlmCallFailedError } from '../../../src/ai/llm/llm-call-failed.error';

const METRICS = ['adherence_trend', 'forecast_accuracy_mape'];

describe('parseNlAnalyticsTranslation', () => {
  it('parses a valid metric_query response', () => {
    const result = parseNlAnalyticsTranslation(
      JSON.stringify({ kind: 'metric_query', metricName: 'adherence_trend', selfReportedConfidence: 0.7 }),
      METRICS,
    );
    expect(result).toEqual({
      kind: 'metric_query',
      metricName: 'adherence_trend',
      orgUnitId: null,
      period: null,
      selfReportedConfidence: 0.7,
    });
  });

  it('parses a valid executive_summary response, including an optional orgUnitId', () => {
    const result = parseNlAnalyticsTranslation(
      JSON.stringify({ kind: 'executive_summary', period: 'last_month', orgUnitId: 'org-1' }),
      METRICS,
    );
    expect(result).toEqual({
      kind: 'executive_summary',
      metricName: null,
      orgUnitId: 'org-1',
      period: 'last_month',
      selfReportedConfidence: 0.5,
    });
  });

  it('strips a markdown code fence some real models wrap the JSON in', () => {
    const result = parseNlAnalyticsTranslation(
      '```json\n' + JSON.stringify({ kind: 'metric_query', metricName: 'adherence_trend' }) + '\n```',
      METRICS,
    );
    expect(result.metricName).toBe('adherence_trend');
  });

  it('rejects a metricName that is not in the real catalog, never fabricating one', () => {
    expect(() =>
      parseNlAnalyticsTranslation(JSON.stringify({ kind: 'metric_query', metricName: 'made_up_metric' }), METRICS),
    ).toThrow(LlmCallFailedError);
  });

  it('rejects an executive_summary response missing a valid period', () => {
    expect(() =>
      parseNlAnalyticsTranslation(JSON.stringify({ kind: 'executive_summary', period: 'yesterday' }), METRICS),
    ).toThrow(LlmCallFailedError);
  });

  it('rejects an unknown "kind"', () => {
    expect(() =>
      parseNlAnalyticsTranslation(JSON.stringify({ kind: 'raw_sql', metricName: 'adherence_trend' }), METRICS),
    ).toThrow(LlmCallFailedError);
  });

  it('rejects non-JSON text', () => {
    expect(() => parseNlAnalyticsTranslation('not json at all', METRICS)).toThrow(LlmCallFailedError);
  });
});
