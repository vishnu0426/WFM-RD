import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SCHEDULING_ELIGIBILITY_GRPC_PACKAGE } from './scheduling-eligibility-grpc-client.constants';

export interface CheckAssignmentEligibilityRequest {
  tenantId: string;
  candidateEmployeeId: string;
  shiftAssignmentId: string;
  orgUnitId: string;
  /** Swap only - empty string = none (proto3 has no null; see the .proto's own comment). */
  excludeShiftAssignmentId: string;
}

export interface EligibilityViolation {
  category: string;
  detail: string;
}

export interface CheckAssignmentEligibilityResponse {
  shiftAssignmentFound: boolean;
  eligible: boolean;
  violations: EligibilityViolation[];
}

interface SchedulingEligibilityServiceClient {
  checkAssignmentEligibility(
    request: CheckAssignmentEligibilityRequest,
  ): Observable<CheckAssignmentEligibilityResponse>;
}

/**
 * §0.5's guardrail-validation SLO is p99 < 500ms, but scheduling-service's
 * own retry budget for the upstream Module 01/02/06 pulls it makes
 * internally can run up to ~2.1s worst-case (ADR-0082's own accounting).
 * 3000ms gives that retry budget room to actually succeed before this
 * client gives up - shorter would turn a legitimate-but-slow success into a
 * spurious failure; there is no explicit timeout at all in this platform's
 * only prior Node gRPC client (`AuditGrpcClientService`) to inherit a
 * convention from, so this is new ground, chosen for this module's own
 * §0.5 chaos requirement (a hung connection must fail closed within a
 * bounded time, never hang the claim indefinitely).
 */
const CALL_TIMEOUT_MS = 3000;

export class GuardrailValidationUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`SchedulingEligibilityService.CheckAssignmentEligibility unavailable: ${(cause as Error).message}`);
    this.name = 'GuardrailValidationUnavailableError';
  }
}

/**
 * Thin wrapper over the `SchedulingEligibilityService` gRPC client
 * (`SchedulingEligibilityGrpcClientModule`) - converts the Observable-
 * returning proxy into a `Promise` (matching every other async call site in
 * this service) and enforces `CALL_TIMEOUT_MS`. Every failure mode -
 * transport error, timeout, malformed response - surfaces as one typed
 * `GuardrailValidationUnavailableError`, so `ClaimOpenShiftService` has a
 * single thing to catch and fail closed on (§0.5's chaos scenario), rather
 * than needing to distinguish gRPC-library-specific error shapes itself.
 */
@Injectable()
export class SchedulingEligibilityGrpcClientService implements OnModuleInit {
  private client!: SchedulingEligibilityServiceClient;

  constructor(@Inject(SCHEDULING_ELIGIBILITY_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<SchedulingEligibilityServiceClient>('SchedulingEligibilityService');
  }

  async checkAssignmentEligibility(
    request: CheckAssignmentEligibilityRequest,
  ): Promise<CheckAssignmentEligibilityResponse> {
    try {
      return await firstValueFrom(this.client.checkAssignmentEligibility(request).pipe(timeout(CALL_TIMEOUT_MS)));
    } catch (err) {
      throw new GuardrailValidationUnavailableError(err);
    }
  }
}
