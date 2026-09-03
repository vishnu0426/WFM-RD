import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { DomainError } from '../errors/domain-error';
import { InvalidTenantIdError, TenantContextMissingError } from '../tenant/tenant-context.errors';

type DomainErrorClass = new (...args: never[]) => DomainError;

const STATUS_BY_ERROR = new Map<DomainErrorClass, HttpStatus>([
  [TenantContextMissingError, HttpStatus.BAD_REQUEST],
  [InvalidTenantIdError, HttpStatus.BAD_REQUEST],
]);

/**
 * Maps typed `DomainError` subclasses to an HTTP status + the platform's
 * standard error envelope, mirrors every other service's own
 * `domain-error.filter.ts`. REST-only (no GraphQL in this service).
 *
 * Note: `AttendanceClockEventClient`'s own errors (HMAC misconfiguration,
 * forward-failed) are deliberately NOT registered here - `/v1/mobile/sync`
 * must return per-action results even when one action's upstream call
 * fails (the source spec's own instruction: "a partial-failure batch...
 * must return per-action results, not fail the whole batch on one
 * conflict"), so `mobile-sync.service.ts` catches those internally and
 * encodes them as a `failed`/`conflict` result for that action, never lets
 * them escape to this filter and fail the whole request.
 */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
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
