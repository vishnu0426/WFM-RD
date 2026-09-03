import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { DomainError } from '../../../common/errors/domain-error';
import { NotFoundError } from '../../../common/errors/not-found.error';
import { ScimInvalidFilterError } from '../errors/scim-invalid-filter.error';

const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

/**
 * RFC 7644 §3.12's SCIM error response shape - controller-scoped, same
 * precedent as `OAuthErrorFilter`: real SCIM clients (Okta/Entra ID
 * connectors) parse `{schemas, status, detail}`, not this platform's own
 * `{error:{code,message,details}}` envelope (§3.4).
 */
@Catch(DomainError, HttpException)
export class ScimErrorFilter implements ExceptionFilter {
  catch(exception: DomainError | HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainError) {
      const status = this.statusFor(exception);
      response.status(status).json({
        schemas: [SCIM_ERROR_SCHEMA],
        status: String(status),
        detail: exception.message,
      });
      return;
    }

    const status = exception.getStatus();
    const body = exception.getResponse();
    const detail = typeof body === 'string' ? body : ((body as { message?: string }).message ?? exception.message);
    response.status(status).json({ schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail });
  }

  private statusFor(exception: DomainError): HttpStatus {
    if (exception instanceof NotFoundError) {
      return HttpStatus.NOT_FOUND;
    }
    if (exception instanceof ScimInvalidFilterError) {
      return HttpStatus.BAD_REQUEST;
    }
    return HttpStatus.BAD_REQUEST;
  }
}
