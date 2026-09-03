import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { NOTIFICATION_PREFERENCE_GRPC_PACKAGE } from './notification-preference-grpc-client.constants';

export interface IsPushEnabledRequest {
  tenantId: string;
  employeeId: string;
  eventType: string;
}

export interface IsPushEnabledResponse {
  enabled: boolean;
  employeeHasLinkedUser: boolean;
}

interface NotificationPreferenceServiceClient {
  isPushEnabled(request: IsPushEnabledRequest): Observable<IsPushEnabledResponse>;
}

/** Same 3000ms budget/rationale as `EmployeeGrpcClientService` - no existing precedent to inherit a different one from. */
const CALL_TIMEOUT_MS = 3000;

/**
 * ADR-0154. Thrown on ANY failure to reach/complete the call - this is the
 * one infra-level failure `LeaveRequestApprovedConsumerService` lets
 * propagate (unlike a permanent per-device outcome), so
 * `DurableJetStreamConsumer`'s base class naks the message for redelivery.
 */
export class NotificationPreferenceGrpcClientUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`NotificationPreferenceService.IsPushEnabled unavailable: ${(cause as Error).message}`);
    this.name = 'NotificationPreferenceGrpcClientUnavailableError';
  }
}

@Injectable()
export class NotificationPreferenceGrpcClientService implements OnModuleInit {
  private client!: NotificationPreferenceServiceClient;

  constructor(@Inject(NOTIFICATION_PREFERENCE_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<NotificationPreferenceServiceClient>('NotificationPreferenceService');
  }

  async isPushEnabled(request: IsPushEnabledRequest): Promise<IsPushEnabledResponse> {
    try {
      return await firstValueFrom(this.client.isPushEnabled(request).pipe(timeout(CALL_TIMEOUT_MS)));
    } catch (err) {
      throw new NotificationPreferenceGrpcClientUnavailableError(err);
    }
  }
}
