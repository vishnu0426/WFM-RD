import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AcknowledgeAbsencePatternService } from './acknowledge-absence-pattern.service';
import { ListAbsencePatternsService } from './list-absence-patterns.service';
import { AcknowledgeAbsencePatternDto } from './dto/acknowledge-absence-pattern.dto';
import { AbsencePattern } from '../entities/absence-pattern.entity';
import { TenantContextService } from '../../common/tenant/tenant-context.service';

/**
 * §3.1/§3.2's `acknowledgeAbsencePattern`, REST-first per this module's
 * established convention (GraphQL lands with whichever phase first needs
 * it - still no phase has). `GET /v1/leave/absence-patterns` (unacknowledged
 * only) is this phase's own addition, not named in §3.2's REST table -
 * added for the same reason `requestLeave`/`decideLeaveRequest` got REST
 * paths ahead of GraphQL: a detection feature with no way to see what it
 * detected is not a testable, working surface.
 */
@Controller('v1/leave/absence-patterns')
export class AbsencePatternController {
  constructor(
    private readonly acknowledgeService: AcknowledgeAbsencePatternService,
    private readonly listService: ListAbsencePatternsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  async listUnacknowledged(): Promise<AbsencePattern[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.listService.listUnacknowledged(tenantId);
  }

  @Post(':id/acknowledge')
  async acknowledge(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AcknowledgeAbsencePatternDto,
  ): Promise<AbsencePattern> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.acknowledgeService.acknowledge(tenantId, id, dto);
  }
}
