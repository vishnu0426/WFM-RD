import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { ScimAuthGuard } from '../guards/scim-auth.guard';
import { ScimErrorFilter } from './scim-error.filter';
import { ScimGroupsService } from '../services/scim-groups.service';
import { ScimGroupWriteDto } from '../dto/scim-group-write.dto';
import { ScimPatchRequestDto } from '../dto/scim-patch-request.dto';
import { toScimGroupView } from './scim-group.view';
import { toScimListResponse } from './scim-list-response';
import { AuditEventBatcherService } from '../../audit/services/audit-event-batcher.service';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

/**
 * §5.3's `/scim/v2/Groups` (RFC 7644) - see `ScimGroupsService`'s doc
 * comment for the Group<->Role mapping.
 *
 * Follow-up to Phase 5 (ADR-0044): every mutation records a fire-and-forget
 * `AuditEventBatcherService` entry - same `actor_type = system` posture as
 * `ScimUsersController`.
 */
@Controller('scim/v2/Groups')
@UseGuards(ScimAuthGuard)
@UseFilters(ScimErrorFilter)
export class ScimGroupsController {
  constructor(
    private readonly service: ScimGroupsService,
    private readonly tenantContext: TenantContextService,
    private readonly auditEvents: AuditEventBatcherService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithTokenClaims) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      const records = await this.service.list();
      const resources = records.map((r) => toScimGroupView(r.role, r.members));
      return toScimListResponse(resources, resources.length, 1, resources.length);
    });
  }

  @Get(':id')
  async get(@Req() req: RequestWithTokenClaims, @Param('id') id: string) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      const record = await this.service.getOrFail(id);
      return toScimGroupView(record.role, record.members);
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() req: RequestWithTokenClaims, @Body() dto: ScimGroupWriteDto) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      const record = await this.service.create(dto);
      this.audit(claims, 'scim_group.created', record.role.id, null, {
        name: record.role.name,
        memberCount: record.members.length,
      });
      return toScimGroupView(record.role, record.members);
    });
  }

  @Put(':id')
  async replace(@Req() req: RequestWithTokenClaims, @Param('id') id: string, @Body() dto: ScimGroupWriteDto) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      const record = await this.service.replace(id, dto);
      this.audit(claims, 'scim_group.replaced', id, null, {
        name: record.role.name,
        memberCount: record.members.length,
      });
      return toScimGroupView(record.role, record.members);
    });
  }

  @Patch(':id')
  async patch(@Req() req: RequestWithTokenClaims, @Param('id') id: string, @Body() dto: ScimPatchRequestDto) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      const record = await this.service.applyPatch(id, dto.Operations);
      this.audit(claims, 'scim_group.patched', id, null, {
        name: record.role.name,
        memberCount: record.members.length,
      });
      return toScimGroupView(record.role, record.members);
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<void> {
    const claims = req.tokenClaims!;
    await this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      await this.service.delete(id);
      this.audit(claims, 'scim_group.deleted', id, null, null);
    });
  }

  private audit(
    claims: RequestWithTokenClaims['tokenClaims'],
    action: string,
    resourceId: string,
    beforeState: Record<string, unknown> | null,
    afterState: Record<string, unknown> | null,
  ): void {
    this.auditEvents.enqueue({
      tenantId: claims!.tenant_id,
      actorId: claims!.sub,
      actorType: AuditActorType.SYSTEM,
      action,
      resourceType: 'role',
      resourceId,
      beforeState,
      afterState,
      aiRationale: null,
    });
  }
}
