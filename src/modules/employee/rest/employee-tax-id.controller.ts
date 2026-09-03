import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';
import { EmployeesService } from '../services/employees.service';

/**
 * The one path in this module that returns a real, unmasked Tax ID —
 * `EmployeeGraphQLType`/the general REST read only ever expose
 * `taxIdLastFour` (`maskTaxId()`). Gated on `employee:write`, the stronger
 * bar, since a full-SSN read is materially more sensitive than an ordinary
 * field read; every call is audited regardless of who's asking, matching
 * §0's specific-consequence-confirmation posture the frontend also applies
 * (a `ConsequenceConfirmDialog` before this is ever called).
 */
@Controller('v1/employees')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeTaxIdController {
  constructor(
    private readonly employeesService: EmployeesService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  @Get(':id/tax-id')
  @RequirePermissions('employee:write')
  async reveal(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<{ taxId: string | null }> {
    const taxId = await this.employeesService.revealTaxId(id);

    const claims = req.tokenClaims!;
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'employee.tax_id_revealed',
      resourceType: 'employee',
      resourceId: id,
      beforeState: null,
      afterState: null,
      aiRationale: null,
    });

    return { taxId };
  }
}
