import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable } from 'rxjs';
import { AUDIT_GRPC_PACKAGE } from './audit-grpc-client.constants';

export interface RecordAuditEventRequest {
  tenantId: string;
  actorId: string;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string;
  beforeStateJson: string;
  afterStateJson: string;
  aiRationaleJson: string;
}

export interface RecordAuditEventResponse {
  accepted: boolean;
  errorCode: string;
}

interface AuditServiceClient {
  recordEvent(request: RecordAuditEventRequest): Observable<RecordAuditEventResponse>;
}

/**
 * Own copy of integration-hub-service's/adherence-compliance-service's
 * identical `AuditGrpcClientService` - analytics-reporting-service's first
 * use of core's `AuditService.RecordEvent`, for Tenant Admin Integration
 * Management WP6's Scorecards Sources mutations. Best-effort: logs and
 * continues rather than failing a mutation that already committed.
 */
@Injectable()
export class AuditGrpcClientService implements OnModuleInit {
  private readonly logger = new Logger(AuditGrpcClientService.name);
  private client!: AuditServiceClient;

  constructor(@Inject(AUDIT_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<AuditServiceClient>('AuditService');
  }

  async record(request: RecordAuditEventRequest): Promise<void> {
    try {
      const response = await firstValueFrom(this.client.recordEvent(request));
      if (!response.accepted) {
        this.logger.warn(`AuditService.RecordEvent rejected: ${response.errorCode} (action=${request.action})`);
      }
    } catch (err) {
      this.logger.warn(`AuditService.RecordEvent call failed (action=${request.action}): ${(err as Error).message}`);
    }
  }
}
