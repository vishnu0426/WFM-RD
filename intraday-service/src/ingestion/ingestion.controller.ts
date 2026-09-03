import { Body, Controller, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { HmacSignatureGuard } from './hmac-signature.guard';
import { IngestionService } from './ingestion.service';
import { ActivityEventDto } from './dto/activity-event.dto';

/**
 * §4.2's primary ingestion path. `tenantId` is a URL path segment, not
 * derived from `TenantContextMiddleware`'s JWT/header convention (root
 * app's `ADR-0049`) - neither applies to a server-to-server ACD/CCaaS
 * webhook. `HmacSignatureGuard` verifying against that tenant's secret *is*
 * the proof of tenant identity for this endpoint (design doc's explicit
 * assumption #1).
 *
 * `202 Accepted` on first sighting (published to NATS, not yet reflected in
 * `AgentLiveState` - that's Phase 2's consumer), `200 OK` on a dedup'd
 * replay - both are success responses an ACD/CCaaS retry policy should
 * treat as "delivered," only a non-2xx should trigger its own retry.
 */
@Controller('v1/intraday/tenants/:tenantId/activity-events')
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post()
  @UseGuards(HmacSignatureGuard)
  async ingest(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() event: ActivityEventDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 'accepted' | 'duplicate'; sourceEventId: string }> {
    const outcome = await this.ingestion.ingest(tenantId, event);
    res.status(outcome === 'accepted' ? 202 : 200);
    return { status: outcome, sourceEventId: event.sourceEventId };
  }
}
