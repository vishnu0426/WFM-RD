import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { Response } from 'express';
import { DomainError } from '../errors/domain-error';
import { InvalidTenantIdError, TenantContextMissingError } from '../tenant/tenant-context.errors';
import { ComplianceRuleNotFoundError } from '../../compliance/errors/compliance-rule-not-found.error';
import { ComplianceRuleNotPendingReviewError } from '../../compliance/errors/compliance-rule-not-pending-review.error';
import { ComplianceRuleCitationRequiredError } from '../../compliance/errors/compliance-rule-citation-required.error';
import { InvalidComplianceRuleEffectiveRangeError } from '../../compliance/errors/invalid-compliance-rule-effective-range.error';
import { ComplianceRuleNotOwnedError } from '../../compliance/errors/compliance-rule-not-owned.error';
import { ComplianceReportNotFoundError } from '../../compliance/reports/errors/compliance-report-not-found.error';
import { OrgUnitScopeRequiredError } from '../../compliance/reports/errors/org-unit-scope-required.error';
import { ImpactPreviewRequiredError } from '../../compliance/errors/impact-preview-required.error';
import { ActivationJustificationRequiredError } from '../../compliance/errors/activation-justification-required.error';
import { InvalidRetentionYearsError } from '../../compliance/errors/invalid-retention-years.error';
import { ScheduleQueryGrpcClientUnavailableError } from '../../grpc/schedule-query-grpc-client.service';

type DomainErrorClass = new (...args: never[]) => DomainError;

const STATUS_BY_ERROR = new Map<DomainErrorClass, HttpStatus>([
  [TenantContextMissingError, HttpStatus.BAD_REQUEST],
  [InvalidTenantIdError, HttpStatus.BAD_REQUEST],
  [ComplianceRuleNotFoundError, HttpStatus.NOT_FOUND],
  [ComplianceRuleNotPendingReviewError, HttpStatus.CONFLICT],
  [ComplianceRuleCitationRequiredError, HttpStatus.BAD_REQUEST],
  [InvalidComplianceRuleEffectiveRangeError, HttpStatus.BAD_REQUEST],
  [ComplianceRuleNotOwnedError, HttpStatus.FORBIDDEN],
  [ComplianceReportNotFoundError, HttpStatus.NOT_FOUND],
  [OrgUnitScopeRequiredError, HttpStatus.BAD_REQUEST],
  // Phase 8 (docs/adr/0107): both previously registered on the GraphQL
  // path only (Phase 5's own `formatGraphQLError`, generic over any
  // `DomainError`) - added here too for REST-path completeness/defense in
  // depth, even though neither is currently thrown from a REST-only code
  // path (`ImpactPreviewRequiredError`: GraphQL-only `activateComplianceRule`
  // resolver; `ScheduleQueryGrpcClientUnavailableError`: the REST-exposed
  // `POST /v1/compliance/reports` catches it internally and never rethrows,
  // ADR-0105's fire-and-forget design).
  [ImpactPreviewRequiredError, HttpStatus.CONFLICT],
  // GraphQL-only today, same "registered here anyway for REST-path
  // completeness" reasoning as ImpactPreviewRequiredError just above.
  [ActivationJustificationRequiredError, HttpStatus.CONFLICT],
  [InvalidRetentionYearsError, HttpStatus.BAD_REQUEST],
  [ScheduleQueryGrpcClientUnavailableError, HttpStatus.SERVICE_UNAVAILABLE],
]);

/**
 * Maps typed `DomainError` subclasses to an HTTP status + the platform's
 * standard error envelope (ADR-0015), mirrors every other service's own
 * `domain-error.filter.ts`. This map backs the REST path only -
 * `ComplianceGraphQLModule`'s own `formatGraphQLError` is GraphQL's
 * equivalent, both reading the same `DomainError.code`. Every later phase
 * adding a new `DomainError` subclass (e.g. Phase 5's impact-preview
 * errors) registers its status here rather than throwing raw
 * `HttpException`s from controllers/services.
 *
 * Registered as a global `APP_FILTER` (`app.module.ts`), this also
 * receives errors thrown from GraphQL resolvers - `host.switchToHttp().
 * getResponse()` is NOT a real Express `Response` there (no `.status()`/
 * `.json()`), a real bug this phase hit on its first live GraphQL exercise
 * (`activateComplianceRule` against an already-active rule, via `curl`),
 * not caught by any unit test mocking the filter directly. Same bailout
 * intraday-service's/shift-marketplace-service's own copies already use:
 * detect the GraphQL context and rethrow, letting Apollo's own
 * `formatError` (`ComplianceGraphQLModule`'s `formatGraphQLError`) do the
 * GraphQL-shaped mapping instead of this REST-only one.
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
