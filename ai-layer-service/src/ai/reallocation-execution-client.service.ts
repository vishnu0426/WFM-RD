import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainError } from '../common/errors/domain-error';

export class ReallocationExecutionFailedError extends DomainError {
  constructor(status: number, body: string) {
    super(
      'REALLOCATION_EXECUTION_FAILED',
      `intraday-service rejected the reallocation approval: HTTP ${status} ${body}`,
    );
  }
}

/**
 * §3/non-negotiable #1's write-back-through-owning-module pathway, made
 * concrete for `recommendation_type: 'reallocation'`: `decideRecommendation`
 * (and `auto_execute_low_risk`) never write to `intraday.reallocation_action`
 * themselves - they call intraday-service's own, already-existing
 * `POST /v1/intraday/reallocations/{id}/approve` (the exact API a human
 * supervisor calling `approveReallocation` directly would use). Unlike
 * `SchedulingWritebackClientService`'s best-effort explanation write-back,
 * this call is NOT best-effort - it is the actual governed action the
 * recommendation described; a failure here must surface as a real error,
 * not be silently swallowed while the recommendation's own status claims
 * success.
 */
@Injectable()
export class ReallocationExecutionClientService {
  constructor(private readonly config: ConfigService) {}

  async approveReallocation(tenantId: string, reallocationActionId: string): Promise<void> {
    const baseUrl = this.config.get<string>('INTRADAY_REST_URL') ?? 'http://localhost:8200';
    const response = await fetch(`${baseUrl}/v1/intraday/reallocations/${reallocationActionId}/approve`, {
      method: 'POST',
      headers: { 'X-Tenant-Id': tenantId },
    });
    if (!response.ok) {
      throw new ReallocationExecutionFailedError(response.status, await response.text());
    }
  }
}
