import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable } from 'rxjs';
import { AUDIT_GRPC_PACKAGE } from './audit-grpc-client.constants';

export interface RecordAuditEventRequest {
  tenantId: string;
  /** Empty string = null (core's own `audit.proto` convention). */
  actorId: string;
  /** 'user' | 'system' | 'ai_agent'. */
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string;
  /** JSON-encoded, empty string = null. */
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
 * Own copy of adherence-compliance-service's/attendance-leave-service's
 * identical `AuditGrpcClientService` - integration-hub-service's first use
 * of core's `AuditService.RecordEvent`, closing this service's previously
 * disclosed "no audit logging exists here at all" gap (Tenant Admin
 * Integration Management plan, decision #8).
 *
 * Every call site in this service treats this as best-effort, same as the
 * adherence-compliance-service precedent: logs and continues rather than
 * failing a mutation that already committed to Postgres. An audit trail
 * gap on a transient gRPC failure is a smaller problem than a connector
 * update silently rejected after it already took effect.
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
