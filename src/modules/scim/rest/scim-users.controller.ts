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
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { ScimAuthGuard } from '../guards/scim-auth.guard';
import { ScimErrorFilter } from './scim-error.filter';
import { ScimUsersService } from '../services/scim-users.service';
import { ScimUserWriteDto } from '../dto/scim-user-write.dto';
import { ScimPatchRequestDto } from '../dto/scim-patch-request.dto';
import { toScimUserView } from './scim-user.view';
import { toScimListResponse } from './scim-list-response';
import { AuditEventBatcherService } from '../../audit/services/audit-event-batcher.service';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

/**
 * §5.3's `/scim/v2/Users` (RFC 7644). See docs/phase-3-design-doc.md for the
 * supported filter/PATCH subset.
 *
 * Follow-up to Phase 5 (ADR-0044): every mutation records a fire-and-forget
 * `AuditEventBatcherService` entry, `actor_type = system` (the caller is an
 * external IdP's SCIM connector, not an interactive user - see
 * `ScimAuthGuard`'s doc comment), `actor_id` the `client:<id>` subject from
 * the `client_credentials` token that authenticated the request.
 */
@Controller('scim/v2/Users')
@UseGuards(ScimAuthGuard)
@UseFilters(ScimErrorFilter)
export class ScimUsersController {
  constructor(
    private readonly service: ScimUsersService,
    private readonly tenantContext: TenantContextService,
    private readonly auditEvents: AuditEventBatcherService,
  ) {}

  @Get()
  async list(
    @Req() req: RequestWithTokenClaims,
    @Query('filter') filter?: string,
    @Query('startIndex') startIndex?: string,
    @Query('count') count?: string,
  ) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      const start = startIndex ? Math.max(1, parseInt(startIndex, 10)) : 1;
      const size = count ? Math.min(200, Math.max(1, parseInt(count, 10))) : 100;
      const { resources, total } = await this.service.list(filter, start, size);
      return toScimListResponse(resources.map(toScimUserView), total, start, size);
    });
  }

  @Get(':id')
  async get(@Req() req: RequestWithTokenClaims, @Param('id') id: string) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () =>
      toScimUserView(await this.service.getOrFail(id)),
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() req: RequestWithTokenClaims, @Body() dto: ScimUserWriteDto) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      const user = await this.service.create(claims.tenant_id, dto);
      this.audit(claims, 'scim_user.created', user.id, null, { userName: user.email, status: user.status });
      return toScimUserView(user);
    });
  }

  @Put(':id')
  async replace(@Req() req: RequestWithTokenClaims, @Param('id') id: string, @Body() dto: ScimUserWriteDto) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      const user = await this.service.replace(id, dto);
      this.audit(claims, 'scim_user.replaced', id, null, { userName: user.email, status: user.status });
      return toScimUserView(user);
    });
  }

  @Patch(':id')
  async patch(@Req() req: RequestWithTokenClaims, @Param('id') id: string, @Body() dto: ScimPatchRequestDto) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      const user = await this.service.applyPatch(id, dto.Operations);
      this.audit(claims, 'scim_user.patched', id, null, { userName: user.email, status: user.status });
      return toScimUserView(user);
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<void> {
    const claims = req.tokenClaims!;
    await this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      await this.service.deactivate(id);
      this.audit(claims, 'scim_user.deactivated', id, null, null);
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
      resourceType: 'user',
      resourceId,
      beforeState,
      afterState,
      aiRationale: null,
    });
  }
}
