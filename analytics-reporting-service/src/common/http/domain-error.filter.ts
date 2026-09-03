import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { Response } from 'express';
import { DomainError } from '../errors/domain-error';
import {
  ActorContextMissingError,
  InvalidTenantIdError,
  TenantContextMissingError,
} from '../tenant/tenant-context.errors';
import { DashboardNotFoundError } from '../../analytics/errors/dashboard-not-found.error';
import { MetricNotFoundError, MetricSourceNotAllowedError } from '../../analytics/errors/metric-not-found.error';
import { ExpensiveMetricNotAllowedOnWidgetError } from '../../analytics/errors/expensive-metric-not-allowed-on-widget.error';
import {
  MetricValidationFailedError,
  UnvalidatedMetricNotAllowedOnWidgetError,
  MetricNameAlreadyExistsError,
} from '../../analytics/errors/metric-validation-failed.error';
import {
  AnalyticsExportNotFoundError,
  AnalyticsExportNotReadyError,
} from '../../analytics/errors/analytics-export-not-found.error';
import { NlQueryBridgeUnavailableError } from '../../analytics/errors/nl-query-bridge-unavailable.error';
import { NlQueryBridgeRateLimitedError } from '../../analytics/errors/nl-query-bridge-rate-limited.error';
import { AnalyticsQuestionTooLongError } from '../../analytics/errors/analytics-question-too-long.error';

type DomainErrorClass = new (...args: never[]) => DomainError;

const STATUS_BY_ERROR = new Map<DomainErrorClass, HttpStatus>([
  [TenantContextMissingError, HttpStatus.BAD_REQUEST],
  [InvalidTenantIdError, HttpStatus.BAD_REQUEST],
  [ActorContextMissingError, HttpStatus.BAD_REQUEST],
  [DashboardNotFoundError, HttpStatus.NOT_FOUND],
  [MetricNotFoundError, HttpStatus.NOT_FOUND],
  [MetricSourceNotAllowedError, HttpStatus.BAD_REQUEST],
  [ExpensiveMetricNotAllowedOnWidgetError, HttpStatus.CONFLICT],
  [MetricValidationFailedError, HttpStatus.BAD_REQUEST],
  [UnvalidatedMetricNotAllowedOnWidgetError, HttpStatus.CONFLICT],
  [MetricNameAlreadyExistsError, HttpStatus.CONFLICT],
  [AnalyticsExportNotFoundError, HttpStatus.NOT_FOUND],
  [AnalyticsExportNotReadyError, HttpStatus.CONFLICT],
  [NlQueryBridgeUnavailableError, HttpStatus.SERVICE_UNAVAILABLE],
  [NlQueryBridgeRateLimitedError, HttpStatus.TOO_MANY_REQUESTS],
  [AnalyticsQuestionTooLongError, HttpStatus.BAD_REQUEST],
]);

/**
 * Maps typed `DomainError` subclasses to an HTTP status + the platform's
 * standard error envelope (ADR-0015), mirrors every other service's own
 * `domain-error.filter.ts`. This map backs the REST path only -
 * `AnalyticsGraphQLModule`'s own `formatGraphQLError` is GraphQL's
 * equivalent, both reading the same `DomainError.code`.
 *
 * Phase 4 adds the GraphQL-context bailout every other service's copy has
 * once a real GraphQL surface exists (`host.switchToHttp().getResponse()`
 * is not a real Express `Response` in a GraphQL execution context - a real
 * bug several prior modules' own Phase-2-equivalent hit on first live
 * GraphQL exercise, not speculative here).
 *
 * Every later phase adding a new `DomainError` subclass registers its
 * status here rather than throwing raw `HttpException`s from
 * controllers/services.
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
