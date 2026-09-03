import { Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { ReallocationAction } from './entities/reallocation-action.entity';
import { ReallocationApprovalService } from './reallocation-approval.service';

/**
 * §4.2: `POST /v1/intraday/reallocations/{id}/approve` - shares
 * `ReallocationApprovalService` with the GraphQL `approveReallocation`
 * mutation (same REST/GraphQL-share-a-service pattern as
 * `LiveStateRestController`/`QueueLiveStateQueryService`, Phase 4).
 */
@Controller('v1/intraday/reallocations')
export class ReallocationRestController {
  constructor(
    private readonly reallocationApproval: ReallocationApprovalService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post(':id/approve')
  async approve(@Param('id', new ParseUUIDPipe()) id: string): Promise<ReallocationAction> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.reallocationApproval.approve(tenantId, id);
  }
}
