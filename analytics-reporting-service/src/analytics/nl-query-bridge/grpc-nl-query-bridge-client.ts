import { Injectable } from '@nestjs/common';
import { AiLayerGrpcClientService, AiLayerGrpcClientUnavailableError } from '../../grpc/ai-layer-grpc-client.service';
import { NlQueryBridgeClient, StructuredAnalyticsQuery } from './nl-query-bridge-client';
import { ExecutiveSummaryPeriod, MetricQueryFilter } from '../metric-query-engine.service';
import { NlQueryBridgeUnavailableError } from '../errors/nl-query-bridge-unavailable.error';
import { NlQueryBridgeRateLimitedError } from '../errors/nl-query-bridge-rate-limited.error';
import { AnalyticsQuestionTooLongError } from '../errors/analytics-question-too-long.error';

const VALID_PERIODS = new Set<string>(Object.values(ExecutiveSummaryPeriod));

/**
 * ADR-0165: the real `NlQueryBridgeClient`, registered in `AnalyticsModule`
 * in place of ADR-0111's `NotAvailableNlQueryBridgeClient`. A thin mapping
 * layer only - `AiLayerGrpcClientService` carries the actual gRPC call,
 * this class's whole job is translating between this module's own typed
 * contract (`StructuredAnalyticsQuery`, this module's `MetricQueryFilter`)
 * and the wire shape Module 10's `NlQueryBridgeService` speaks
 * (flat proto strings/JSON, an `errorCode` field instead of a thrown
 * exception - see nl_query_bridge.proto's own doc comment for why).
 *
 * `filterJson` round-trips through `translateQuestion` unused today -
 * Module 10's own `parseNlAnalyticsTranslation` never populates it (its
 * prompt only asks the model for `kind`/`metricName`/`orgUnitId`/`period`,
 * not a full filter) - kept on the wire contract for a future phase to
 * fill in (e.g. a question naming an explicit date range) without another
 * proto/interface change, parsed defensively here regardless.
 */
@Injectable()
export class GrpcNlQueryBridgeClient implements NlQueryBridgeClient {
  constructor(private readonly grpcClient: AiLayerGrpcClientService) {}

  async translateQuestion(
    tenantId: string,
    userId: string | null,
    question: string,
    availableMetricNames: string[],
  ): Promise<StructuredAnalyticsQuery> {
    const response = await this.call(() =>
      this.grpcClient.translateQuestion({ tenantId, userId: userId ?? '', question, availableMetricNames }),
    );
    this.throwOnError(response.errorCode, response.retryAfterSeconds);

    if (response.kind === 'metric_query') {
      return {
        kind: 'metricQuery',
        metricName: response.metricName,
        filter: parseFilterJson(response.filterJson),
      };
    }
    return {
      kind: 'executiveSummary',
      orgUnitId: response.orgUnitId || undefined,
      period: VALID_PERIODS.has(response.period)
        ? (response.period as ExecutiveSummaryPeriod)
        : ExecutiveSummaryPeriod.CURRENT_MONTH,
    };
  }

  async generateAnswer(tenantId: string, userId: string | null, question: string, results: unknown): Promise<string> {
    const response = await this.call(() =>
      this.grpcClient.generateAnswer({
        tenantId,
        userId: userId ?? '',
        question,
        resultsJson: JSON.stringify(results),
      }),
    );
    this.throwOnError(response.errorCode, response.retryAfterSeconds);
    return response.answerText;
  }

  /** A real transport failure (network/timeout) - `AiLayerGrpcClientUnavailableError` - gets the same typed 503 a business-level `errorCode: "UNAVAILABLE"` response gets; neither should ever surface as a raw, unmapped 500. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AiLayerGrpcClientUnavailableError) {
        throw new NlQueryBridgeUnavailableError();
      }
      throw err;
    }
  }

  private throwOnError(errorCode: string, retryAfterSeconds: number): void {
    switch (errorCode) {
      case '':
        return;
      case 'RATE_LIMITED':
        throw new NlQueryBridgeRateLimitedError(retryAfterSeconds);
      case 'QUESTION_TOO_LONG':
        throw new AnalyticsQuestionTooLongError();
      default:
        throw new NlQueryBridgeUnavailableError();
    }
  }
}

function parseFilterJson(filterJson: string): MetricQueryFilter | undefined {
  if (!filterJson) {
    return undefined;
  }
  try {
    return JSON.parse(filterJson) as MetricQueryFilter;
  } catch {
    return undefined;
  }
}
