import { Body, Controller, ForbiddenException, Post, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../auth/access-token.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { EmployeeSessionVerificationService } from '../grpc/employee-session-verification.service';
import { RegisterDeviceRequestDto } from './dto/register-device-request.dto';
import { DevicesService } from './devices.service';

/**
 * `POST /v1/mobile/devices` (source spec §3.1's `registerDevice`, built as
 * REST not GraphQL - ADR-0154, same call ADR-0151 already made for
 * `syncOfflineActions`). Tenant from `TenantContextService`, never a body
 * field - same posture as `MobileSyncController`. `employeeId` verified
 * against the caller's own session (ADR-0150/ADR-0157) before registering.
 */
@Controller('v1/mobile')
@UseGuards(AccessTokenGuard, TenantTokenMatchGuard)
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly tenantContext: TenantContextService,
    private readonly employeeSession: EmployeeSessionVerificationService,
  ) {}

  @Post('devices')
  async register(
    @Body() dto: RegisterDeviceRequestDto,
    @Req() request: RequestWithTokenClaims,
  ): Promise<{ id: string; deviceType: string; active: boolean; lastActiveAt: string }> {
    const tenantId = this.tenantContext.requireTenantId();
    if (!request.tokenClaims) {
      throw new ForbiddenException('Access token claims are missing.');
    }
    await this.employeeSession.assertEmployeeIdMatchesSession(request.tokenClaims, dto.employeeId);
    const row = await this.devices.register(tenantId, dto);
    return {
      id: row.id,
      deviceType: row.deviceType,
      active: row.active,
      lastActiveAt: row.lastActiveAt.toISOString(),
    };
  }
}
