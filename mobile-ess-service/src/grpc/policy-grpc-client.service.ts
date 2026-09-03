import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, timeout } from 'rxjs';
import { POLICY_GRPC_PACKAGE } from './policy-grpc-client.constants';

export interface GetActivePolicyRequest {
  tenantId: string;
  policyGroupId: string;
  policyType: string;
  orgUnitId: string;
  asOf: string;
}

export interface PolicyResponse {
  found: boolean;
  id: string;
  policyGroupId: string;
  policyType: string;
  orgUnitId: string;
  /** JSON-encoded `Policy.definition` - caller parses per-policyType shape. */
  definitionJson: string;
  effectiveFrom: string;
  effectiveTo: string;
  version: number;
}

interface PolicyServiceClient {
  getActivePolicy(request: GetActivePolicyRequest): Observable<PolicyResponse>;
}

const CALL_TIMEOUT_MS = 3000;

export class PolicyGrpcClientUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`PolicyService.GetActivePolicy unavailable: ${(cause as Error).message}`);
    this.name = 'PolicyGrpcClientUnavailableError';
  }
}

/**
 * ADR-0155. Thin wrapper over the `PolicyService` gRPC client
 * (`PolicyGrpcClientModule`), same shape as this service's own
 * `NotificationPreferenceGrpcClientService` (Phase 5). `getActivePolicy`
 * takes `orgUnitId` required (never tenant-wide `''`) - `GeofenceVerificationService`
 * is the only caller and geofence boundaries are always org-unit-scoped.
 */
@Injectable()
export class PolicyGrpcClientService implements OnModuleInit {
  private client!: PolicyServiceClient;

  constructor(@Inject(POLICY_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<PolicyServiceClient>('PolicyService');
  }

  async getActivePolicy(tenantId: string, policyType: string, orgUnitId: string): Promise<PolicyResponse> {
    try {
      return await firstValueFrom(
        this.client
          .getActivePolicy({ tenantId, policyGroupId: '', policyType, orgUnitId, asOf: '' })
          .pipe(timeout(CALL_TIMEOUT_MS)),
      );
    } catch (err) {
      throw new PolicyGrpcClientUnavailableError(err);
    }
  }
}
