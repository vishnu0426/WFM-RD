import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable } from 'rxjs';
import { AUDIT_GRPC_PACKAGE } from './audit-grpc-client.constants';

export interface RecordAuditEventRequest {
  tenantId: string;
  /** Empty string = null (core's own `audit.proto` convention - a system/ai_agent action with no human actor). */
  actorId: string;
  /** 'user' | 'system' | 'ai_agent' - always 'user' for this service's Phase 6 call sites (a human decided a LeaveRequest). */
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
 * Thin wrapper over the `AuditService.RecordEvent` gRPC client
 * (`AuditGrpcClientModule`) - converts `@nestjs/microservices`'s
 * Observable-returning proxy into a `Promise`, matching how every other
 * async call site in this service already reads. This is the first
 * Node-to-Node gRPC client anywhere in this platform (every prior gRPC
 * client in this repo is scheduling-service's Python side); there is no
 * existing pattern to diverge from, so this mirrors this service's own
 * gRPC *server* conventions (`LeaveGrpcController`) as closely as a client
 * reasonably can.
 */
@Injectable()
export class AuditGrpcClientService implements OnModuleInit {
  private client!: AuditServiceClient;

  constructor(@Inject(AUDIT_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<AuditServiceClient>('AuditService');
  }

  /** Throws on transport failure or `accepted: false` - callers in this service treat both as "the audit call failed" and decide for themselves whether that's fatal (Phase 6's decision path treats it as best-effort, see `DecideLeaveRequestService`). */
  async recordEvent(request: RecordAuditEventRequest): Promise<void> {
    const response = await firstValueFrom(this.client.recordEvent(request));
    if (!response.accepted) {
      throw new Error(`AuditService.RecordEvent rejected: ${response.errorCode}`);
    }
  }
}
