import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainError } from '../common/errors/domain-error';

export class ForecastingServiceUnavailableError extends DomainError {
  constructor(operation: string, cause: string) {
    super('FORECASTING_SERVICE_UNAVAILABLE', `forecasting-service ${operation} failed: ${cause}`);
  }
}

export interface CcQueue {
  id: string;
  orgUnitId: string;
  externalQueueId: string;
  name: string;
  acdProvider: string | null;
  channel: string;
  status: string;
}

/**
 * Tenant Admin Integration Management, WP3/WP4: this service's first HTTP
 * client to forecasting-service - `CcQueue` is the real canonical Queue
 * entity (already built there, full CRUD REST at
 * `/v1/forecasting/cc-queues`), reused rather than duplicated (plan
 * decision #3). No NestJS-to-forecasting-service HTTP client existed
 * anywhere in this platform before this (the one prior cross-service
 * pairing, ai-layer-service, uses gRPC) - this is plain REST because
 * forecasting-service exposes `cc-queues` as REST only, no proto.
 *
 * Same header-trust posture forecasting-service's own `get_tenant_context`
 * already documents (`X-Tenant-Id`, ADR-0014-equivalent) - not a new,
 * weaker mechanism introduced by this client.
 */
@Injectable()
export class ForecastingHttpClientService {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('FORECASTING_SERVICE_URL', 'http://localhost:8000');
  }

  /** Returns null on 404 (queue id does not exist / not visible to this tenant) rather than throwing - a normal, expected outcome for validation call sites. */
  async findCcQueueById(tenantId: string, ccQueueId: string): Promise<CcQueue | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/forecasting/cc-queues/${ccQueueId}`, {
        method: 'GET',
        headers: { 'X-Tenant-Id': tenantId },
      });
    } catch (err) {
      throw new ForecastingServiceUnavailableError('GET /v1/forecasting/cc-queues/:id', (err as Error).message);
    }
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new ForecastingServiceUnavailableError(
        'GET /v1/forecasting/cc-queues/:id',
        `HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as {
      id: string;
      org_unit_id: string;
      external_queue_id: string;
      name: string;
      acd_provider: string | null;
      channel: string;
      status: string;
    };
    return {
      id: body.id,
      orgUnitId: body.org_unit_id,
      externalQueueId: body.external_queue_id,
      name: body.name,
      acdProvider: body.acd_provider,
      channel: body.channel,
      status: body.status,
    };
  }
}
