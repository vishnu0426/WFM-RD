import { MetricQueryFilter, ExecutiveSummaryPeriod } from '../metric-query-engine.service';

export const NL_QUERY_BRIDGE_CLIENT = Symbol('NL_QUERY_BRIDGE_CLIENT');

/**
 * §4.1's `metricQuery`/`executiveSummary` are the only two structured
 * shapes `askAnalyticsQuestion` can execute - Module 10's translation
 * must resolve to one of them, never a third, ad-hoc shape (this module
 * still owns query execution, per §4.1's own boundary; Module 10 owning
 * "NL translation" means picking between these two existing entry
 * points, not inventing a new one).
 */
export type StructuredAnalyticsQuery =
  | { kind: 'metricQuery'; metricName: string; filter?: MetricQueryFilter }
  | { kind: 'executiveSummary'; orgUnitId?: string; period: ExecutiveSummaryPeriod };

/**
 * ADR-0111 named the contract; ADR-0165 gives it a real implementation
 * (`GrpcNlQueryBridgeClient`, calling Module 10's own new
 * `NlQueryBridgeService` gRPC surface) and, in doing so, widens both
 * methods beyond ADR-0111's original guess - exactly the "revisit with its
 * own ADR then, not now" ADR-0111 flagged as acceptable:
 *
 * - `userId`: threaded through from the GraphQL resolver's own
 *   `@CurrentTokenClaims()` (previously unused by this resolver) purely so
 *   Module 10's own `AiInteraction`/rate-limiting can attribute the call to
 *   a real actor, same as every other `AIInteraction`-generating operation
 *   in this platform already does - `AskAnalyticsQuestionService` itself
 *   never reads it.
 * - `availableMetricNames` (added to `translateQuestion` only): the real,
 *   tenant-visible metric catalog (`MetricDefinitionService.listVisibleMetrics`)
 *   - without it, translation has no way to know which metric names are
 *   real, and ADR-0165's own `parseNlAnalyticsTranslation` (Module 10)
 *   depends on this list being real and current, not guessed.
 */
export interface NlQueryBridgeClient {
  translateQuestion(
    tenantId: string,
    userId: string | null,
    question: string,
    availableMetricNames: string[],
  ): Promise<StructuredAnalyticsQuery>;
  generateAnswer(tenantId: string, userId: string | null, question: string, results: unknown): Promise<string>;
}
