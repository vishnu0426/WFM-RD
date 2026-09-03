import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { AuditLogRepository } from '../repositories/audit-log.repository';
import { AuditActorType } from '../entities/audit-actor-type.enum';
import { AuditLog } from '../entities/audit-log.entity';

/** §3.2's `GET /v1/audit-log` - paginated, filterable by actor_type/resource_type/date range. */
@Controller('v1/audit-log')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class AuditLogController {
  constructor(private readonly auditLogRepository: AuditLogRepository) {}

  @Get()
  @RequirePermissions('audit:read')
  async list(
    @Req() req: RequestWithTokenClaims,
    @Query('resourceType') resourceType?: string,
    @Query('resourceId') resourceId?: string,
    @Query('actorType') actorType?: AuditActorType,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLog[]> {
    const claims = req.tokenClaims!;
    return this.auditLogRepository.findByTenant(claims.tenant_id, {
      resourceType,
      resourceId,
      actorType,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      before: before ? new Date(before) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
