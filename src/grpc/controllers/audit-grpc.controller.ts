import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { AuditEventBatcherService } from '../../modules/audit/services/audit-event-batcher.service';
import { AuditActorType } from '../../modules/audit/entities/audit-actor-type.enum';
import { AiRationaleRequiredError } from '../../modules/audit/errors/ai-rationale-required.error';

interface RecordEventRequest {
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

interface RecordEventResponse {
  accepted: boolean;
  errorCode: string;
}

/**
 * §3.3's `AuditService`. Validation (§2.2 rule 3) happens here,
 * synchronously, before the event is ever handed to
 * `AuditEventBatcherService` - a caller gets an immediate, correct
 * rejection for a malformed `ai_agent` event, not a response that claims
 * success for something that will actually fail at the next async flush.
 */
@Controller()
export class AuditGrpcController {
  private readonly logger = new Logger(AuditGrpcController.name);

  constructor(private readonly batcher: AuditEventBatcherService) {}

  @GrpcMethod('AuditService', 'RecordEvent')
  recordEvent(request: RecordEventRequest): RecordEventResponse {
    try {
      this.batcher.enqueue({
        tenantId: request.tenantId,
        actorId: request.actorId || null,
        actorType: request.actorType as AuditActorType,
        action: request.action,
        resourceType: request.resourceType,
        resourceId: request.resourceId || null,
        beforeState: request.beforeStateJson ? JSON.parse(request.beforeStateJson) : null,
        afterState: request.afterStateJson ? JSON.parse(request.afterStateJson) : null,
        aiRationale: request.aiRationaleJson ? JSON.parse(request.aiRationaleJson) : null,
      });
      return { accepted: true, errorCode: '' };
    } catch (err) {
      if (err instanceof AiRationaleRequiredError) {
        return { accepted: false, errorCode: err.code };
      }
      this.logger.error(`RecordEvent rejected for tenant=${request.tenantId}: ${(err as Error).message}`);
      return { accepted: false, errorCode: 'INVALID_REQUEST' };
    }
  }
}
