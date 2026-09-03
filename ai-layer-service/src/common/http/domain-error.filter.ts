import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { Response } from 'express';
import { DomainError } from '../errors/domain-error';
import {
  InvalidTenantIdError,
  TenantContextMissingError,
  CrossTenantDataAssemblyError,
} from '../tenant/tenant-context.errors';
import { ScheduleJobNotFoundError } from '../../ai/errors/schedule-job-not-found.error';
import { SchedulingGrpcClientUnavailableError } from '../../grpc/scheduling-grpc-client.service';
import { LlmCallFailedError } from '../../ai/llm/llm-call-failed.error';
import { AiProviderNotConfiguredError } from '../../ai/errors/ai-provider-not-configured.error';
import { AiProviderConfigInvalidError } from '../../ai/errors/ai-provider-config-invalid.error';
import { OllamaUnreachableError } from '../../ai/errors/ollama-unreachable.error';
import { ForecastRunNotFoundError } from '../../ai/errors/forecast-run-not-found.error';
import { ForecastingGrpcClientUnavailableError } from '../../grpc/forecasting-grpc-client.service';
import { ReallocationNotFoundError } from '../../ai/errors/reallocation-not-found.error';
import { IntradayGrpcClientUnavailableError } from '../../grpc/intraday-grpc-client.service';
import { ComplianceGrpcClientUnavailableError } from '../../grpc/compliance-grpc-client.service';
import { RootCauseAnalysisNoDataError } from '../../ai/errors/root-cause-analysis-no-data.error';
import { AiInteractionNotFoundError } from '../../ai/errors/ai-interaction-not-found.error';
import { AiInteractionDegradedError } from '../../ai/errors/ai-interaction-degraded.error';
import { AiInteractionNotRecommendableError } from '../../ai/errors/ai-interaction-not-recommendable.error';
import { AiRecommendationNotFoundError } from '../../ai/errors/ai-recommendation-not-found.error';
import { AiRecommendationNotDecidableError } from '../../ai/errors/ai-recommendation-not-decidable.error';
import { ReallocationExecutionFailedError } from '../../ai/reallocation-execution-client.service';
import { AskQuestionContextInvalidError } from '../../ai/errors/ask-question-context-invalid.error';
import { AiAssistantUnavailableError } from '../../ai/errors/ai-assistant-unavailable.error';

type DomainErrorClass = new (...args: never[]) => DomainError;

const STATUS_BY_ERROR = new Map<DomainErrorClass, HttpStatus>([
  [TenantContextMissingError, HttpStatus.BAD_REQUEST],
  [InvalidTenantIdError, HttpStatus.BAD_REQUEST],
  [ScheduleJobNotFoundError, HttpStatus.NOT_FOUND],
  [SchedulingGrpcClientUnavailableError, HttpStatus.SERVICE_UNAVAILABLE],
  // Not the caller's fault - a query-router assembly bug, never something
  // fixable by adjusting the request. 500, not a 4xx, so it isn't read as
  // "your request was wrong."
  [CrossTenantDataAssemblyError, HttpStatus.INTERNAL_SERVER_ERROR],
  // Should normally never escape `ScheduleExplanationService` (caught
  // internally to enter §4's degraded-mode path) - mapped defensively in
  // case a future call site forgets to catch it.
  [LlmCallFailedError, HttpStatus.SERVICE_UNAVAILABLE],
  // Same defensive posture - the BYOK equivalent of the above (docs/adr/0117).
  [AiProviderNotConfiguredError, HttpStatus.SERVICE_UNAVAILABLE],
  // docs/adr/0129 - a caller-supplied apiKey/baseUrl combination that doesn't match what the chosen provider needs.
  [AiProviderConfigInvalidError, HttpStatus.BAD_REQUEST],
  // docs/adr/0129/0133 - a caller-supplied Ollama baseUrl this service couldn't reach at configuration time.
  [OllamaUnreachableError, HttpStatus.BAD_REQUEST],
  // Phase 4 (docs/adr/0119/0120/0121/0122) - same shapes as their Phase 2 precedents.
  [ForecastRunNotFoundError, HttpStatus.NOT_FOUND],
  [ForecastingGrpcClientUnavailableError, HttpStatus.SERVICE_UNAVAILABLE],
  [ReallocationNotFoundError, HttpStatus.NOT_FOUND],
  [IntradayGrpcClientUnavailableError, HttpStatus.SERVICE_UNAVAILABLE],
  [ComplianceGrpcClientUnavailableError, HttpStatus.SERVICE_UNAVAILABLE],
  // Neither source had anything at all - a genuine "nothing to analyze"
  // case (§4.2's non-negotiable #2), not the caller's fault, but not a
  // transport failure either. 404, same family as the other not-found errors.
  [RootCauseAnalysisNoDataError, HttpStatus.NOT_FOUND],
  // Phase 5 (docs/adr/0123/0124) - AIRecommendation lifecycle errors.
  [AiInteractionNotFoundError, HttpStatus.NOT_FOUND],
  [AiInteractionDegradedError, HttpStatus.CONFLICT],
  [AiInteractionNotRecommendableError, HttpStatus.BAD_REQUEST],
  [AiRecommendationNotFoundError, HttpStatus.NOT_FOUND],
  [AiRecommendationNotDecidableError, HttpStatus.CONFLICT],
  // The owning module's own governed API rejected the execution call -
  // not this module's own bug, but not silently swallowed either
  // (non-negotiable #1: this IS the real write, unlike a best-effort
  // audit/write-back-of-an-explanation call).
  [ReallocationExecutionFailedError, HttpStatus.BAD_GATEWAY],
  // Phase 6 (docs/adr/0126/0127) - `askQuestion`.
  [AskQuestionContextInvalidError, HttpStatus.BAD_REQUEST],
  // §4's degraded-mode contract, `askQuestion`'s own variant (see the
  // error class's own doc comment for why this is thrown, not swallowed).
  [AiAssistantUnavailableError, HttpStatus.SERVICE_UNAVAILABLE],
]);

/**
 * Maps typed `DomainError` subclasses to an HTTP status + the platform's
 * standard error envelope (ADR-0015), mirrors every other service's own
 * `domain-error.filter.ts`. This map backs the REST path only (`/healthz`/
 * `/readyz`/`/metrics` in this phase - GraphQL is this module's primary
 * surface); `AiGraphQLModule`'s own `formatGraphQLError` is GraphQL's
 * equivalent, both reading the same `DomainError.code`.
 *
 * Registered as a global `APP_FILTER` (`app.module.ts`) - the GraphQL
 * bailout below (rethrow, let Apollo's `formatError` handle it instead) is
 * the same real bug every other service's own copy of this filter already
 * documents fixing: `host.switchToHttp().getResponse()` is not a real
 * Express `Response` in a GraphQL execution context.
 */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
    if (host.getType<GqlContextType>() === 'graphql') {
      throw exception;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = STATUS_BY_ERROR.get(exception.constructor as DomainErrorClass) ?? HttpStatus.INTERNAL_SERVER_ERROR;
    response.status(status).json({
      error: {
        code: exception.code,
        message: exception.message,
      },
    });
  }
}
