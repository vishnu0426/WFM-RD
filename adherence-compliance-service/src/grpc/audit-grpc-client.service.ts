import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable } from 'rxjs';
import { AUDIT_GRPC_PACKAGE } from './audit-grpc-client.constants';

export interface RecordAuditEventRequest {
  tenantId: string;
  /** Empty string = null (core's own `audit.proto` convention). */
  actorId: string;
  /** 'user' | 'system' | 'ai_agent' - always 'system' for this service's Phase 5 call site (no human actor decided the activation; the rule reviewer did, but this event records the platform noticing the flagged risk, not the activation decision itself). */
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
 * Own copy of attendance-leave-service's identical `AuditGrpcClientService`
 * - thin Promise wrapper over `AuditService.RecordEvent`
 * (`AuditGrpcClientModule`). Throws on transport failure or
 * `accepted: false`; `ComplianceRuleService.activateRule` treats this call
 * as best-effort (logs and continues rather than failing the activation
 * that already committed - see docs/adr/0104).
 */
@Injectable()
export class AuditGrpcClientService implements OnModuleInit {
  private client!: AuditServiceClient;

  constructor(@Inject(AUDIT_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<AuditServiceClient>('AuditService');
  }

  async recordEvent(request: RecordAuditEventRequest): Promise<void> {
    const response = await firstValueFrom(this.client.recordEvent(request));
    if (!response.accepted) {
      throw new Error(`AuditService.RecordEvent rejected: ${response.errorCode}`);
    }
  }
}
