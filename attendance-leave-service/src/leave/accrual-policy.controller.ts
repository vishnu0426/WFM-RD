import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AccrualPolicyService } from './accrual-policy.service';
import { CreateAccrualPolicyDto } from './dto/create-accrual-policy.dto';
import { UpdateAccrualPolicyDto } from './dto/update-accrual-policy.dto';
import { AccrualPolicy } from './entities/accrual-policy.entity';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';

/**
 * User Management audit GAP-02: full CRUD for `AccrualPolicy`, closing the
 * gap that no recurring accrual mechanism (or catalog to drive one from)
 * existed anywhere in this service. Same guard/permission shape as
 * `LeaveTypeController` — admin-only tenant-wide catalog CRUD.
 */
@Controller('v1/accrual-policies')
@UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
export class AccrualPolicyController {
  constructor(
    private readonly accrualPolicyService: AccrualPolicyService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @RequirePermissions('accrual_policy:read')
  async findAll(): Promise<AccrualPolicy[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.accrualPolicyService.findAll(tenantId);
  }

  @Get(':id')
  @RequirePermissions('accrual_policy:read')
  async findOne(@Param('id') id: string): Promise<AccrualPolicy> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.accrualPolicyService.findById(tenantId, id);
  }

  @Post()
  @RequirePermissions('accrual_policy:write')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateAccrualPolicyDto): Promise<AccrualPolicy> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.accrualPolicyService.create(tenantId, dto);
  }

  @Patch(':id')
  @RequirePermissions('accrual_policy:write')
  async update(@Param('id') id: string, @Body() dto: UpdateAccrualPolicyDto): Promise<AccrualPolicy> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.accrualPolicyService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('accrual_policy:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.accrualPolicyService.delete(tenantId, id);
  }
}
