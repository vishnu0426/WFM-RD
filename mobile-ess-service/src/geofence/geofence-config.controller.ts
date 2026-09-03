import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../auth/access-token.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { EmployeeSessionVerificationService } from '../grpc/employee-session-verification.service';
import { GeofenceConfigQueryDto } from './dto/geofence-config-query.dto';
import { GeofenceConfig, GeofenceVerificationService } from './geofence-verification.service';

/**
 * `GET /v1/mobile/geofence-config` (ADR-0155). Lets the mobile app decide
 * whether to show the disclosure gate / attempt location capture at all -
 * never shown to an employee whose org unit hasn't opted in. Deliberately
 * never returns the boundary's center coordinates - actual verification
 * always happens server-side, at sync time (`GeofenceVerificationService.evaluate`,
 * consumed by `mobile-sync.service.ts`). `employeeId` verified against the
 * caller's own session (ADR-0150/ADR-0157).
 */
@Controller('v1/mobile')
@UseGuards(AccessTokenGuard, TenantTokenMatchGuard)
export class GeofenceConfigController {
  constructor(
    private readonly geofenceVerification: GeofenceVerificationService,
    private readonly tenantContext: TenantContextService,
    private readonly employeeSession: EmployeeSessionVerificationService,
  ) {}

  @Get('geofence-config')
  async getConfig(
    @Query() dto: GeofenceConfigQueryDto,
    @Req() request: RequestWithTokenClaims,
  ): Promise<GeofenceConfig> {
    const tenantId = this.tenantContext.requireTenantId();
    if (!request.tokenClaims) {
      throw new ForbiddenException('Access token claims are missing.');
    }
    await this.employeeSession.assertEmployeeIdMatchesSession(request.tokenClaims, dto.employeeId);
    return this.geofenceVerification.getConfigForEmployee(tenantId, dto.employeeId);
  }
}
