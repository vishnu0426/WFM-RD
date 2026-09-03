import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { AdherenceExceptionQueryService } from './adherence-exception-query.service';
import { AdherenceExceptionService } from './adherence-exception.service';
import { ResolveAdherenceExceptionDto } from './dto/resolve-adherence-exception.dto';
import { AdherenceException, AdherenceExceptionStatus } from './entities/adherence-exception.entity';

/**
 * `GET /v1/intraday/adherence-exceptions` (optional `status`/`employeeId`
 * filters) plus the acknowledge/resolve actions - the scorecard-facing
 * surface for `AdherenceException` (see that entity's own doc comment).
 * REST-only, same posture `ReallocationRestController` takes for its
 * action endpoints - no GraphQL resolver this pass.
 */
@Controller('v1/intraday/adherence-exceptions')
export class AdherenceExceptionRestController {
  constructor(
    private readonly query: AdherenceExceptionQueryService,
    private readonly exceptions: AdherenceExceptionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  async list(
    @Query('status') status?: AdherenceExceptionStatus,
    @Query('employeeId') employeeId?: string,
  ): Promise<AdherenceException[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.query.list(tenantId, { status, employeeId });
  }

  @Post(':id/acknowledge')
  async acknowledge(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdherenceException> {
    const tenantId = this.tenantContext.requireTenantId();
    const actorId = this.tenantContext.requireActorId();
    return this.exceptions.acknowledge(tenantId, id, actorId);
  }

  @Post(':id/resolve')
  async resolve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ResolveAdherenceExceptionDto,
  ): Promise<AdherenceException> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.exceptions.resolve(tenantId, id, body.resolutionNotes);
  }
}
