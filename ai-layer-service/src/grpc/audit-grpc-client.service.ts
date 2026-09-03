import { Inject, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable } from 'rxjs';
import { AUDIT_GRPC_PACKAGE } from './audit-grpc-client.constants';

export interface RecordAuditEventRequest {
  tenantId: string;
  /** Empty string = null (core's own `audit.proto` convention). */
  actorId: string;
  /** 'user' | 'system' | 'ai_agent' - always 'ai_agent' for this service's call sites, per §2.2 rule 3. */
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string;
  /** JSON-encoded, empty string = null. */
  beforeStateJson: string;
  afterStateJson: string;
  /** REQUIRED (non-empty) for actorType = 'ai_agent' - core's AuditEventBatcherService rejects the call synchronously otherwise. */
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
 * Own copy of every other Node service's identical `AuditGrpcClientService`
 * - thin Promise wrapper over `AuditService.RecordEvent`
 * (`AuditGrpcClientModule`). Best-effort by design: a query-router call that
 * already returned a real answer to the user must not fail (or roll back
 * anything) because the audit write afterward couldn't reach core - logs
 * and continues, same posture ADR-0104 already established for this exact
 * shape of "the real work already happened, the audit trail is important
 * but not itself the source of truth" call.
 */
@Injectable()
export class AuditGrpcClientService implements OnModuleInit {
  private readonly logger = new Logger(AuditGrpcClientService.name);
  private client!: AuditServiceClient;

  constructor(@Inject(AUDIT_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<AuditServiceClient>('AuditService');
  }

  async recordEvent(request: RecordAuditEventRequest): Promise<void> {
    try {
      const response = await firstValueFrom(this.client.recordEvent(request));
      if (!response.accepted) {
        this.logger.warn(`AuditService.RecordEvent rejected: ${response.errorCode}`);
      }
    } catch (err) {
      this.logger.warn(`AuditService.RecordEvent unavailable: ${(err as Error).message}`);
    }
  }
}
