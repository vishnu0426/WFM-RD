import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { Response } from 'express';
import { DomainError } from '../errors/domain-error';
import { InvalidTenantIdError, TenantContextMissingError } from '../tenant/tenant-context.errors';
import { VaultSecretNotFoundError, VaultUnavailableError } from '../../vault/vault.errors';
import { RawCredentialInConfigError } from '../../connectors/errors/raw-credential-in-config.error';
import { InvalidCreateConnectorInputError } from '../../connectors/errors/invalid-create-connector-input.error';
import { ConnectorNotFoundError } from '../../connectors/errors/connector-not-found.error';
import {
  ConnectorNotPendingOAuthSetupError,
  OAuthStateMismatchError,
  OAuthTokenExchangeFailedError,
} from '../../connectors/errors/oauth-callback.errors';
import { NoBatchAdapterRegisteredError } from '../../sync/errors/no-batch-adapter-registered.error';
import { SyncNotSupportedForConnectorTypeError } from '../../sync/errors/sync-not-supported-for-connector-type.error';
import { RelayNotSupportedForConnectorTypeError } from '../../sync/errors/relay-not-supported-for-connector-type.error';
import { NoRelayAdapterRegisteredError } from '../../sync/errors/no-relay-adapter-registered.error';
import { NoActiveRelaySessionError } from '../../sync/errors/no-active-relay-session.error';

type DomainErrorClass = new (...args: never[]) => DomainError;

const STATUS_BY_ERROR = new Map<DomainErrorClass, HttpStatus>([
  [TenantContextMissingError, HttpStatus.BAD_REQUEST],
  [InvalidTenantIdError, HttpStatus.BAD_REQUEST],
  // Phase 2 (ADR-0134/0135/0137):
  [VaultUnavailableError, HttpStatus.SERVICE_UNAVAILABLE],
  [VaultSecretNotFoundError, HttpStatus.NOT_FOUND],
  [RawCredentialInConfigError, HttpStatus.BAD_REQUEST],
  [InvalidCreateConnectorInputError, HttpStatus.BAD_REQUEST],
  [ConnectorNotFoundError, HttpStatus.NOT_FOUND],
  [ConnectorNotPendingOAuthSetupError, HttpStatus.CONFLICT],
  [OAuthStateMismatchError, HttpStatus.UNAUTHORIZED],
  [OAuthTokenExchangeFailedError, HttpStatus.BAD_GATEWAY],
  [NoBatchAdapterRegisteredError, HttpStatus.NOT_IMPLEMENTED],
  [SyncNotSupportedForConnectorTypeError, HttpStatus.BAD_REQUEST],
  [RelayNotSupportedForConnectorTypeError, HttpStatus.BAD_REQUEST],
  [NoRelayAdapterRegisteredError, HttpStatus.NOT_IMPLEMENTED],
  [NoActiveRelaySessionError, HttpStatus.CONFLICT],
]);

/**
 * Maps typed `DomainError` subclasses to an HTTP status + the platform's
 * standard error envelope (ADR-0015), mirrors every other service's
 * `domain-error.filter.ts`. Phase 2 registers every error class it
 * introduces here rather than throwing raw `HttpException`s from
 * controllers/services - see `docs/module-12-phase-2-design-doc.md`.
 *
 * GraphQL context re-throws rather than writing an HTTP response - own
 * copy of ai-layer-service's fix for the identical bug (`host.switchToHttp().
 * getResponse()` doesn't return a real Express `Response` under a GraphQL
 * context; `formatGraphQLError`, wired in `graphql.module.ts`, is what
 * actually maps the re-thrown error to a GraphQL error shape). Caught live
 * by this phase's own real end-to-end verification (a real `createConnector`
 * mutation against the running app threw `response.status is not a
 * function` before this fix), not by a unit test - the same class of gap
 * `HttpMetricsInterceptor`'s own fix in this same phase closed.
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
