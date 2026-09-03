import { Inject, Injectable } from '@nestjs/common';
import { MetricQueryEngineService, MetricResultData } from './metric-query-engine.service';
import { MetricDefinitionService } from './metric-definition.service';
import { NL_QUERY_BRIDGE_CLIENT, NlQueryBridgeClient } from './nl-query-bridge/nl-query-bridge-client';

export interface AnalyticsAnswerData {
  question: string;
  answerText: string;
  results: MetricResultData[];
}

/**
 * Phase 7 (§4.1/§5/§8 Phase 7, ADR-0111): `askAnalyticsQuestion`'s
 * orchestration - "Module 09 owns the query execution, Module 10 owns the
 * NL translation and response generation" (§4.1's own words), made
 * concrete. `translateQuestion`/`generateAnswer` are Module 10's job
 * (`NlQueryBridgeClient`, injected); the structured query's actual
 * execution reuses `MetricQueryEngineService.query`/`executiveSummary`
 * directly - this service never re-implements or bypasses query
 * execution, it only sits between the two `NlQueryBridgeClient` calls.
 *
 * Fully testable (and tested) against a mock `NlQueryBridgeClient`
 * regardless of whether the real implementation (ADR-0165's
 * `GrpcNlQueryBridgeClient`) is reachable - this orchestration logic is
 * proven correct independent of Module 10's own availability.
 *
 * ADR-0165: passes `userId` (for Module 10's own `AiInteraction`/rate-limit
 * attribution - this service never reads it back) and the tenant's real,
 * currently-visible metric catalog (`MetricDefinitionService.listVisibleMetrics`)
 * to `translateQuestion` - the one grounding fact that keeps Module 10 from
 * hallucinating a metric name this module would just reject at query time.
 */
@Injectable()
export class AskAnalyticsQuestionService {
  constructor(
    @Inject(NL_QUERY_BRIDGE_CLIENT) private readonly bridgeClient: NlQueryBridgeClient,
    private readonly metricQueryEngine: MetricQueryEngineService,
    private readonly metricDefinitions: MetricDefinitionService,
  ) {}

  async ask(tenantId: string, userId: string | null, question: string): Promise<AnalyticsAnswerData> {
    const visibleMetrics = await this.metricDefinitions.listVisibleMetrics(tenantId);
    const availableMetricNames = visibleMetrics.map((m) => m.name);

    const structuredQuery = await this.bridgeClient.translateQuestion(tenantId, userId, question, availableMetricNames);

    const results =
      structuredQuery.kind === 'metricQuery'
        ? await this.metricQueryEngine.query(tenantId, structuredQuery.metricName, structuredQuery.filter ?? {})
        : await this.metricQueryEngine.executiveSummary(tenantId, structuredQuery.orgUnitId, structuredQuery.period);

    const answerText = await this.bridgeClient.generateAnswer(tenantId, userId, question, results);

    return { question, answerText, results };
  }
}
