import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestWithTokenClaims } from './access-token.guard';
import { PERMISSIONS_METADATA_KEY } from './require-permissions.decorator';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Own copy of adherence-compliance-service's `PermissionsGuard` - the same
 * RBAC idiom, trimmed to HTTP-only (this service has no GraphQL module and
 * no `@nestjs/graphql` dependency to switch context on). Checks
 * `request.tokenClaims.permissions` (§3.4's flat `["resource:action", ...]`
 * claim) against `@RequirePermissions(...)`. Must run after
 * `AccessTokenGuard` in the same `@UseGuards(...)` list - this guard only
 * reads `tokenClaims`, it doesn't validate the token itself.
 *
 * First use of this guard in attendance-leave-service (`GET
 * /v1/leave/requests`, `GET /v1/attendance/exceptions`) - the RBAC-only,
 * not-org-unit-verified posture matches `ComplianceReportController`'s own
 * disclosed limitation: holding the permission is sufficient, the
 * caller-supplied `orgUnitId` is trusted as a filter, not cross-checked
 * against the caller's own managed org unit.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly metrics: MetricsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<string[]>(PERMISSIONS_METADATA_KEY, context.getHandler());
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithTokenClaims>();
    const claims = request.tokenClaims;
    if (!claims) {
      this.metrics.recordRbacDenial('unauthenticated');
      throw new UnauthorizedException('PermissionsGuard requires AccessTokenGuard to run first.');
    }

    const missing = required.filter((permission) => !claims.permissions.includes(permission));
    if (missing.length > 0) {
      this.metrics.recordRbacDenial('forbidden_permission');
      throw new ForbiddenException(`Missing required permission(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
