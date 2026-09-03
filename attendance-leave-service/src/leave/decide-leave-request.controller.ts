import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { DecideLeaveRequestService } from './decide-leave-request.service';
import { DecideLeaveRequestDto } from './dto/decide-leave-request.dto';
import { LeaveRequest } from './entities/leave-request.entity';
import { TenantContextService } from '../common/tenant/tenant-context.service';

/**
 * REST mirror of §3.1's `decideLeaveRequest` mutation - not itself in
 * §3.2's REST table (which only lists `requestLeave`'s REST surface
 * explicitly), added here for the same reason `requestLeave` got a REST
 * path ahead of GraphQL: this phase needs a testable, working surface
 * without building GraphQL a phase early. See the Phase 4 design doc's
 * explicit assumptions.
 */
@Controller('v1/leave/requests')
export class DecideLeaveRequestController {
  constructor(
    private readonly decideLeaveRequestService: DecideLeaveRequestService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post(':id/decision')
  async decide(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DecideLeaveRequestDto,
  ): Promise<LeaveRequest> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.decideLeaveRequestService.decide(tenantId, id, dto);
  }
}
