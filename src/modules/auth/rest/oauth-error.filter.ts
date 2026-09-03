import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { Response } from 'express';
import { OAuthDomainError } from '../errors/oauth-domain.error';

/**
 * Controller-scoped, takes precedence over the global `DomainErrorFilter`
 * (`APP_FILTER`) for `OAuthController`/`WellKnownController` even though
 * `OAuthDomainError extends DomainError` - Nest resolves the nearest
 * matching filter, and `@UseFilters` on the controller is nearer than a
 * global provider. Renders RFC 6749/7009/7662's `{error, error_description}`
 * shape (§3.4's envelope does not apply here - see `OAuthController`'s own
 * doc comment).
 */
@Catch(OAuthDomainError, HttpException)
export class OAuthErrorFilter implements ExceptionFilter {
  catch(exception: OAuthDomainError | HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof OAuthDomainError) {
      response.status(exception.httpStatus).json({
        error: exception.oauthError,
        error_description: exception.message,
      });
      return;
    }

    // Nest's own HttpException - notably the *global* ValidationPipe
    // (registered in main.ts, applied before any controller-scoped pipe
    // could run its own exceptionFactory) throws its default
    // BadRequestException on a malformed body before this controller ever
    // sees the request. Caught here and reshaped into RFC 6749's
    // `{error, error_description}` rather than Nest's default
    // `{statusCode, message, error}` body, so even "malformed JSON"/"missing
    // required field" stays in the shape an OAuth client library expects.
    const status = exception.getStatus();
    const body = exception.getResponse();
    const rawMessage = typeof body === 'string' ? body : (body as { message?: string | string[] }).message;
    const message = Array.isArray(rawMessage) ? rawMessage.join('; ') : (rawMessage ?? exception.message);
    response.status(status).json({ error: 'invalid_request', error_description: message });
  }
}
