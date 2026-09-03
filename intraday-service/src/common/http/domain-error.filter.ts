import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { Response } from 'express';
import { DomainError } from '../errors/domain-error';

/**
 * REST error envelope (`{ error: { code, message, details } }`, ADR-0015's
 * shape, same as the root app's `DomainErrorFilter`). Phase 4 adds GraphQL
 * - registered as a global `APP_FILTER`, this also receives GraphQL
 * resolver errors, and `host.switchToHttp().getResponse()` is NOT a real
 * Express `Response` there (no `.status()`/`.json()`) - same bailout root's
 * own filter uses: detect the GraphQL context and rethrow, letting Apollo's
 * own `formatError` (`graphql.module.ts`) do the GraphQL-shaped mapping
 * instead of this REST-only one.
 */
const STATUS_BY_CODE: Record<string, HttpStatus> = {
  INVALID_SIGNATURE: HttpStatus.UNAUTHORIZED,
  UPSTREAM_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  TENANT_CONTEXT_MISSING: HttpStatus.BAD_REQUEST,
  INVALID_TENANT_ID: HttpStatus.BAD_REQUEST,
  QUEUE_NOT_FOUND: HttpStatus.NOT_FOUND,
  ACTOR_CONTEXT_MISSING: HttpStatus.BAD_REQUEST,
  ALERT_NOT_FOUND: HttpStatus.NOT_FOUND,
  REALLOCATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  REALLOCATION_NOT_SUGGESTED: HttpStatus.CONFLICT,
  ADHERENCE_EXCEPTION_NOT_FOUND: HttpStatus.NOT_FOUND,
  ADHERENCE_EXCEPTION_ALREADY_RESOLVED: HttpStatus.CONFLICT,
  INGESTION_CREDENTIAL_NOT_FOUND: HttpStatus.NOT_FOUND,
  VAULT_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  VAULT_SECRET_NOT_FOUND: HttpStatus.SERVICE_UNAVAILABLE,
};

@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
    if (host.getType<GqlContextType>() === 'graphql') {
      throw exception;
    }

    const response = host.switchToHttp().getResponse<Response>();
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
    response.status(status).json({
      error: { code: exception.code, message: exception.message, details: null },
    });
  }
}
