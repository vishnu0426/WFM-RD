import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { Response } from 'express';
import { DomainError } from '../errors/domain-error';
import { InvalidTenantIdError, TenantContextMissingError } from '../tenant/tenant-context.errors';
import { MarketplacePostNotFoundError } from '../../marketplace/errors/marketplace-post-not-found.error';
import { PostNotOpenError } from '../../marketplace/errors/post-not-open.error';
import { PostAlreadyBeingClaimedError } from '../../marketplace/errors/post-already-being-claimed.error';
import { MarketplaceUnavailableError } from '../../marketplace/errors/marketplace-unavailable.error';
import { GuardrailValidationUnavailableError } from '../../marketplace/errors/guardrail-validation-unavailable.error';
import { ActorContextMissingError } from '../tenant/tenant-context.errors';
import { SwapRequestNotFoundError } from '../../marketplace/errors/swap-request-not-found.error';
import { SwapRequestNotPendingError } from '../../marketplace/errors/swap-request-not-pending.error';
import { NotYourSwapToRespondToError } from '../../marketplace/errors/not-your-swap-to-respond-to.error';
import { SwapOfferedShiftRequiredError } from '../../marketplace/errors/swap-offered-shift-required.error';
import { SwapAlreadyBeingRespondedToError } from '../../marketplace/errors/swap-already-being-responded-to.error';
import { MarketplaceClaimNotFoundError } from '../../marketplace/errors/marketplace-claim-not-found.error';
import { ActionNotPendingApprovalError } from '../../marketplace/errors/action-not-pending-approval.error';
import { ApproveMarketplaceActionInputInvalidError } from '../../marketplace/errors/approve-marketplace-action-input-invalid.error';
import { ClaimAttemptRateLimitExceededError } from '../../marketplace/errors/claim-attempt-rate-limit-exceeded.error';

type DomainErrorClass = new (...args: never[]) => DomainError;

const STATUS_BY_ERROR = new Map<DomainErrorClass, HttpStatus>([
  [TenantContextMissingError, HttpStatus.BAD_REQUEST],
  [InvalidTenantIdError, HttpStatus.BAD_REQUEST],
  [ActorContextMissingError, HttpStatus.BAD_REQUEST],
  [MarketplacePostNotFoundError, HttpStatus.NOT_FOUND],
  [PostNotOpenError, HttpStatus.CONFLICT],
  [PostAlreadyBeingClaimedError, HttpStatus.CONFLICT],
  [MarketplaceUnavailableError, HttpStatus.SERVICE_UNAVAILABLE],
  [GuardrailValidationUnavailableError, HttpStatus.SERVICE_UNAVAILABLE],
  [SwapRequestNotFoundError, HttpStatus.NOT_FOUND],
  [SwapRequestNotPendingError, HttpStatus.CONFLICT],
  [NotYourSwapToRespondToError, HttpStatus.FORBIDDEN],
  [SwapOfferedShiftRequiredError, HttpStatus.BAD_REQUEST],
  [SwapAlreadyBeingRespondedToError, HttpStatus.CONFLICT],
  [MarketplaceClaimNotFoundError, HttpStatus.NOT_FOUND],
  [ActionNotPendingApprovalError, HttpStatus.CONFLICT],
  [ApproveMarketplaceActionInputInvalidError, HttpStatus.BAD_REQUEST],
  [ClaimAttemptRateLimitExceededError, HttpStatus.TOO_MANY_REQUESTS],
]);

/**
 * Maps typed `DomainError` subclasses to an HTTP status + the platform's
 * standard error envelope (ADR-0015), own copy of every prior service's
 * `domain-error.filter.ts`. Every later phase adding a new `DomainError`
 * subclass registers its status here rather than throwing raw
 * `HttpException`s from controllers/resolvers/services.
 *
 * Registered as a global `APP_FILTER` (`app.module.ts`), this also
 * receives errors thrown from GraphQL resolvers - `host.switchToHttp().
 * getResponse()` is NOT a real Express `Response` there (no `.status()`/
 * `.json()`), a real bug this module hit on its first live GraphQL boot
 * (`npm run build && node dist/src/main.js`, not caught by any unit test
 * mocking the filter directly). Same bailout intraday-service's own copy
 * already uses: detect the GraphQL context and rethrow, letting Apollo's
 * own `formatError` (`MarketplaceGraphQLModule`'s `formatGraphQLError`) do
 * the GraphQL-shaped mapping instead of this REST-only one.
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
