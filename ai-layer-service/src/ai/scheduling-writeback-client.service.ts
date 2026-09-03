import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * §1/§6.2 step 7's write-back half: "calls back into the owning module's
 * normal write API/gRPC (e.g. Module 05's `approveReallocation`)" - for
 * schedule explanations specifically, that's Module 04's existing `POST
 * /v1/scheduling/jobs/{jobId}/explanation` (REST, not gRPC - the write side
 * of this handoff was already built in Module 04's own Phase 6, unlike the
 * read side this module's Phase 2 had to add). This is the ordinary
 * "call another service's REST API" pattern this platform already uses
 * elsewhere (webhook delivery's own `fetch` usage) - global `fetch`, no new
 * HTTP client dependency.
 *
 * Best-effort: a failure here never fails `explainSchedule` itself - the
 * caller already received a real `AIInteraction` with a real explanation;
 * only Module 04's own stored copy would be stale, a reconcilable gap
 * (Module 10 can resubmit - `submit_explanation` upserts) rather than a
 * reason to discard an otherwise-successful response.
 */
@Injectable()
export class SchedulingWritebackClientService {
  private readonly logger = new Logger(SchedulingWritebackClientService.name);

  constructor(private readonly config: ConfigService) {}

  async submitScheduleExplanation(
    tenantId: string,
    jobId: string,
    summaryText: string,
    topConstraints: Record<string, unknown>,
    tradeOffs: Record<string, unknown>,
  ): Promise<void> {
    const baseUrl = this.config.get<string>('SCHEDULING_REST_URL') ?? 'http://localhost:8100';
    try {
      const response = await fetch(`${baseUrl}/v1/scheduling/jobs/${jobId}/explanation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
        // generatedByModelId: Module 04's schema models this as a uuid FK
        // into an AI-model registry that doesn't exist anywhere in this
        // platform (§2.1's own `AIInteraction` has no such registry either -
        // an Anthropic model identifier is a string, not a uuid). Always
        // null until/unless a real model registry exists - never a
        // fabricated uuid. Disclosed in docs/adr/0116.
        body: JSON.stringify({ summaryText, topConstraints, tradeOffs, generatedByModelId: null }),
      });
      if (!response.ok) {
        this.logger.warn(`scheduling-service explanation write-back failed: HTTP ${response.status}`);
      }
    } catch (err) {
      this.logger.warn(`scheduling-service explanation write-back unavailable: ${(err as Error).message}`);
    }
  }
}
