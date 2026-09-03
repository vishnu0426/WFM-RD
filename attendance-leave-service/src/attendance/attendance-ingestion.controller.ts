import { Body, Controller, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { HmacSignatureGuard } from './hmac-signature.guard';
import { AttendanceIngestionService } from './attendance-ingestion.service';
import { ClockEventDto } from './dto/clock-event.dto';

/**
 * §3.2's primary ingestion path. `tenantId` is a URL path segment, not
 * derived from `TenantContextMiddleware`'s header-trust convention -
 * neither applies to a server-to-server badge/biometric webhook.
 * `HmacSignatureGuard` verifying against that tenant's secret *is* the
 * proof of tenant identity for this endpoint, same explicit-assumption
 * posture Module 05 Phase 1 already established for the identical
 * structural need (this phase's design doc, assumption 1).
 *
 * `202 Accepted` on first sighting, `200 OK` on a dedup'd replay - both are
 * success responses a device/vendor retry policy should treat as
 * "delivered."
 */
@Controller('v1/attendance/tenants/:tenantId/clock-events')
export class AttendanceIngestionController {
  constructor(private readonly ingestion: AttendanceIngestionService) {}

  @Post()
  @UseGuards(HmacSignatureGuard)
  async ingest(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() event: ClockEventDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 'accepted' | 'duplicate'; sourceEventId: string; attendanceRecordId: string }> {
    const result = await this.ingestion.ingest(tenantId, event);
    res.status(result.outcome === 'accepted' ? 202 : 200);
    return {
      status: result.outcome,
      sourceEventId: event.sourceEventId,
      attendanceRecordId: result.attendanceRecordId,
    };
  }
}
