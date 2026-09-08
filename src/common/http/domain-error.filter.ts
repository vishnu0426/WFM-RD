import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { Response } from 'express';
import { DomainError } from '../errors/domain-error';

/**
 * REST error envelope for every `DomainError` this module (and Module 01's
 * shared primitives) can throw. GraphQL doesn't go through Nest exception
 * filters the same way - see `formatGraphQLError` in `app.module.ts` for the
 * GraphQL-side equivalent of this mapping.
 *
 * §3.2's "standard error envelope" cross-cutting requirement has no existing
 * shared implementation yet (Module 01 has no REST controllers as of its own
 * Phase 1) - this is the first cut, kept intentionally small (one status-code
 * lookup table) so Module 01 can adopt or harden it rather than this module
 * silently becoming the de facto owner of platform-wide REST error shape.
 */
const STATUS_BY_CODE: Record<string, HttpStatus> = {
  TENANT_CONTEXT_MISSING: HttpStatus.BAD_REQUEST,
  INVALID_TENANT_ID: HttpStatus.BAD_REQUEST,
  TENANT_MISMATCH: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_STATE_TRANSITION: HttpStatus.CONFLICT,
  ERASURE_REQUEST_ACTOR_REQUIRED: HttpStatus.BAD_REQUEST,
  // Phase 3 (§5.7's IdP-downtime/expired-cert/expired-request error cases).
  SSO_REQUEST_EXPIRED: HttpStatus.BAD_REQUEST,
  SSO_ASSERTION_INVALID: HttpStatus.BAD_REQUEST,
  SSO_PROVIDER_UNAVAILABLE: HttpStatus.BAD_GATEWAY,
  // `SsoController` reuses this OAuthDomainError code outside OAuthController's
  // own OAuthErrorFilter (which has its own, RFC-shaped handling) - mapped
  // here too so the generic envelope still returns the right status.
  OAUTH_INVALID_CLIENT: HttpStatus.UNAUTHORIZED,
  WEBAUTHN_CHALLENGE_EXPIRED: HttpStatus.BAD_REQUEST,
  WEBAUTHN_VERIFICATION_FAILED: HttpStatus.BAD_REQUEST,
  // Phase 4 (§3.1's ABAC requirement) - distinct from a bare 403 from
  // PermissionsGuard: this means "you hold the permission, but not scoped
  // to this org unit," not "you don't hold the permission at all."
  ABAC_SCOPE_DENIED: HttpStatus.FORBIDDEN,
  // Module 08 Phase 8 (docs/adr/0107): ComplianceGrpcClientUnavailableError -
  // a real, disclosed dependency-unavailable case, not a generic server
  // error.
  COMPLIANCE_SERVICE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  // Frontend Phase 8 gap-fix (`UserManagementController`): inviteUser/accept-invite.
  EMAIL_ALREADY_IN_USE: HttpStatus.CONFLICT,
  INVALID_OR_EXPIRED_INVITE: HttpStatus.BAD_REQUEST,
  // Frontend Phase 8 gap-fix (Roles Setup screen): `PATCH /v1/roles/:id`
  // refuses to edit a system role - a state-mismatch (this row exists, but
  // in a shape that forbids the requested operation), same family as
  // INVALID_STATE_TRANSITION above.
  SYSTEM_ROLE_IMMUTABLE: HttpStatus.CONFLICT,
  // `POST /v1/employees/:id/avatar` - rejected mimetype or missing file.
  INVALID_AVATAR_FILE: HttpStatus.BAD_REQUEST,
  // Frontend Phase 8 follow-up (`UserManagementController`): resend-invite/set-username.
  USER_NOT_INVITED: HttpStatus.CONFLICT,
  USERNAME_ALREADY_IN_USE: HttpStatus.CONFLICT,
  // UserRole group-scope gap-fix: scopeOrgUnitId and scopeGroupId are mutually exclusive.
  INVALID_ROLE_SCOPE: HttpStatus.BAD_REQUEST,
  // Data Source gap-fix: agent id/extension uniqueness scoped per data source.
  AGENT_IDENTITY_ALREADY_IN_USE: HttpStatus.CONFLICT,
  // System Configuration gap-fix: TenantSettings' password policy fields are
  // now actually enforced in PasswordAuthService.setPassword.
  WEAK_PASSWORD: HttpStatus.BAD_REQUEST,
  // System Configuration gap-fix: System Limits (SystemLimitsPolicyService).
  SYSTEM_LIMIT_EXCEEDED: HttpStatus.CONFLICT,
  // Platform Settings gap-fix: PlatformSecurityBaselineService.
  PLATFORM_SECURITY_BASELINE_VIOLATION: HttpStatus.CONFLICT,
};

@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
    // Registered as a global APP_FILTER, so it also receives GraphQL
    // resolver errors - host.switchToHttp().getResponse() is NOT a real
    // Express Response there (no .status()/.json()), so this must bail out
    // and let Apollo's own pipeline (formatGraphQLError) handle it instead
    // of throwing a second, unrelated error trying to call REST-only methods
    // on a non-REST response object.
    if (host.getType<GqlContextType>() === 'graphql') {
      throw exception;
    }

    const httpContext = host.switchToHttp();
    const response = httpContext.getResponse<Response>();
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;

    response.status(status).json({
      error: {
        code: exception.code,
        message: exception.message,
        details: exception.details ?? null,
      },
    });
  }
}
