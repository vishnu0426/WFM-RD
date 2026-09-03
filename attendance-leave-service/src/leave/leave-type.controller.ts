import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { LeaveTypeService } from './leave-type.service';
import { CreateLeaveTypeDto } from './dto/create-leave-type.dto';
import { UpdateLeaveTypeDto } from './dto/update-leave-type.dto';
import { LeaveType } from './entities/leave-type.entity';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';

/**
 * User Management "Time Off" screen gap-fix: full CRUD for `LeaveType`,
 * previously seed/read-only with no controller of any kind. Guarded the
 * same way `LeaveRequestController.listRequests` is - this service's only
 * other RBAC-guarded surface - rather than the unguarded `TenantContextMiddleware`-only
 * posture `requestLeave`/`submitBackdatedLeave` use, since admin-only CRUD
 * on a tenant-wide catalog is a materially different risk than an
 * employee submitting their own leave request.
 */
@Controller('v1/leave-types')
@UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
export class LeaveTypeController {
  constructor(
    private readonly leaveTypeService: LeaveTypeService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @RequirePermissions('leave_type:read')
  async findAll(): Promise<LeaveType[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.leaveTypeService.findAll(tenantId);
  }

  @Get(':id')
  @RequirePermissions('leave_type:read')
  async findOne(@Param('id') id: string): Promise<LeaveType> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.leaveTypeService.findById(tenantId, id);
  }

  @Post()
  @RequirePermissions('leave_type:write')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateLeaveTypeDto): Promise<LeaveType> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.leaveTypeService.create(tenantId, dto);
  }

  @Patch(':id')
  @RequirePermissions('leave_type:write')
  async update(@Param('id') id: string, @Body() dto: UpdateLeaveTypeDto): Promise<LeaveType> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.leaveTypeService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('leave_type:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.leaveTypeService.delete(tenantId, id);
  }
}
