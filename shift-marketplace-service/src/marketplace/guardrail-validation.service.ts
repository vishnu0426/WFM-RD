import { Injectable } from '@nestjs/common';
import {
  EligibilityViolation,
  GuardrailValidationUnavailableError as GrpcGuardrailValidationUnavailableError,
  SchedulingEligibilityGrpcClientService,
} from '../grpc/scheduling-eligibility-grpc-client.service';
import { GuardrailValidationUnavailableError } from './errors/guardrail-validation-unavailable.error';
import { MetricsService } from '../common/metrics/metrics.service';

export interface GuardrailValidationOutcome {
  shiftAssignmentFound: boolean;
  eligible: boolean;
  violations: EligibilityViolation[];
}

/**
 * §0/§4's non-negotiable, in one place: every guardrail check - a real
 * `claimOpenShift`, a read-only `eligibleForMe` resolution, and (Phase 3)
 * `proposeSwap`/`respondToSwap` - calls this same method, which calls this
 * same gRPC surface. There is exactly one path from "is this assignment
 * allowed" to Module 04's real constraint logic (ADR-0082); nothing in
 * this module re-implements or approximates it.
 *
 * Translates the gRPC client's own transport-level error into this
 * module's typed `GuardrailValidationUnavailableError` (a `DomainError`,
 * formattable by both the REST filter and the GraphQL `formatError` hook) -
 * callers never need to know this check happens over gRPC at all.
 */
@Injectable()
export class GuardrailValidationService {
  constructor(
    private readonly eligibilityClient: SchedulingEligibilityGrpcClientService,
    private readonly metrics: MetricsService,
  ) {}

  async checkEligibility(params: {
    tenantId: string;
    candidateEmployeeId: string;
    shiftAssignmentId: string;
    orgUnitId: string;
    excludeShiftAssignmentId?: string;
  }): Promise<GuardrailValidationOutcome> {
    const start = process.hrtime.bigint();
    try {
      const response = await this.eligibilityClient.checkAssignmentEligibility({
        tenantId: params.tenantId,
        candidateEmployeeId: params.candidateEmployeeId,
        shiftAssignmentId: params.shiftAssignmentId,
        orgUnitId: params.orgUnitId,
        excludeShiftAssignmentId: params.excludeShiftAssignmentId ?? '',
      });
      this.metrics.guardrailValidationTotal.inc({
        result: response.shiftAssignmentFound && response.eligible ? 'pass' : 'fail',
      });
      return {
        shiftAssignmentFound: response.shiftAssignmentFound,
        eligible: response.eligible,
        violations: response.violations,
      };
    } catch (err) {
      if (err instanceof GrpcGuardrailValidationUnavailableError) {
        this.metrics.guardrailValidationTotal.inc({ result: 'unavailable' });
        throw new GuardrailValidationUnavailableError();
      }
      throw err;
    } finally {
      this.metrics.guardrailValidationDuration.observe(Number(process.hrtime.bigint() - start) / 1e9);
    }
  }
}
