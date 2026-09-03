import { GuardrailValidationService } from '../../../src/marketplace/guardrail-validation.service';
import {
  GuardrailValidationUnavailableError as GrpcGuardrailValidationUnavailableError,
  SchedulingEligibilityGrpcClientService,
} from '../../../src/grpc/scheduling-eligibility-grpc-client.service';
import { GuardrailValidationUnavailableError } from '../../../src/marketplace/errors/guardrail-validation-unavailable.error';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

describe('GuardrailValidationService (§0/§4, ADR-0082/0086)', () => {
  it('translates the gRPC client response into a plain outcome', async () => {
    const client = {
      checkAssignmentEligibility: jest.fn().mockResolvedValue({
        shiftAssignmentFound: true,
        eligible: false,
        violations: [{ category: 'min_rest', detail: 'x' }],
      }),
    };
    const service = new GuardrailValidationService(
      client as unknown as SchedulingEligibilityGrpcClientService,
      new MetricsService(),
    );

    const outcome = await service.checkEligibility({
      tenantId: 't1',
      candidateEmployeeId: 'e1',
      shiftAssignmentId: 's1',
      orgUnitId: 'o1',
    });

    expect(outcome).toEqual({
      shiftAssignmentFound: true,
      eligible: false,
      violations: [{ category: 'min_rest', detail: 'x' }],
    });
    expect(client.checkAssignmentEligibility).toHaveBeenCalledWith({
      tenantId: 't1',
      candidateEmployeeId: 'e1',
      shiftAssignmentId: 's1',
      orgUnitId: 'o1',
      excludeShiftAssignmentId: '',
    });
  });

  it('§0.5 chaos: translates a gRPC transport/timeout failure into the typed DomainError, never lets the raw gRPC error escape', async () => {
    const client = {
      checkAssignmentEligibility: jest
        .fn()
        .mockRejectedValue(new GrpcGuardrailValidationUnavailableError(new Error('deadline exceeded'))),
    };
    const service = new GuardrailValidationService(
      client as unknown as SchedulingEligibilityGrpcClientService,
      new MetricsService(),
    );

    await expect(
      service.checkEligibility({ tenantId: 't1', candidateEmployeeId: 'e1', shiftAssignmentId: 's1', orgUnitId: 'o1' }),
    ).rejects.toBeInstanceOf(GuardrailValidationUnavailableError);
  });

  it('passes excludeShiftAssignmentId through for the swap case', async () => {
    const client = {
      checkAssignmentEligibility: jest
        .fn()
        .mockResolvedValue({ shiftAssignmentFound: true, eligible: true, violations: [] }),
    };
    const service = new GuardrailValidationService(
      client as unknown as SchedulingEligibilityGrpcClientService,
      new MetricsService(),
    );

    await service.checkEligibility({
      tenantId: 't1',
      candidateEmployeeId: 'e1',
      shiftAssignmentId: 's1',
      orgUnitId: 'o1',
      excludeShiftAssignmentId: 'give-up-shift-1',
    });

    expect(client.checkAssignmentEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ excludeShiftAssignmentId: 'give-up-shift-1' }),
    );
  });

  describe('marketplace_guardrail_validation_total (Shift Marketplace Manager View phase)', () => {
    it('records result=pass when eligible and the shift assignment is found', async () => {
      const client = {
        checkAssignmentEligibility: jest
          .fn()
          .mockResolvedValue({ shiftAssignmentFound: true, eligible: true, violations: [] }),
      };
      const metrics = new MetricsService();
      const service = new GuardrailValidationService(
        client as unknown as SchedulingEligibilityGrpcClientService,
        metrics,
      );

      await service.checkEligibility({
        tenantId: 't1',
        candidateEmployeeId: 'e1',
        shiftAssignmentId: 's1',
        orgUnitId: 'o1',
      });

      const values = (await metrics.guardrailValidationTotal.get()).values;
      expect(values.find((v) => v.labels.result === 'pass')?.value).toBe(1);
    });

    it('records result=fail when not eligible', async () => {
      const client = {
        checkAssignmentEligibility: jest
          .fn()
          .mockResolvedValue({ shiftAssignmentFound: true, eligible: false, violations: [] }),
      };
      const metrics = new MetricsService();
      const service = new GuardrailValidationService(
        client as unknown as SchedulingEligibilityGrpcClientService,
        metrics,
      );

      await service.checkEligibility({
        tenantId: 't1',
        candidateEmployeeId: 'e1',
        shiftAssignmentId: 's1',
        orgUnitId: 'o1',
      });

      const values = (await metrics.guardrailValidationTotal.get()).values;
      expect(values.find((v) => v.labels.result === 'fail')?.value).toBe(1);
    });

    it('records result=unavailable when the gRPC call fails, distinct from a real ineligibility', async () => {
      const client = {
        checkAssignmentEligibility: jest
          .fn()
          .mockRejectedValue(new GrpcGuardrailValidationUnavailableError(new Error('deadline exceeded'))),
      };
      const metrics = new MetricsService();
      const service = new GuardrailValidationService(
        client as unknown as SchedulingEligibilityGrpcClientService,
        metrics,
      );

      await expect(
        service.checkEligibility({
          tenantId: 't1',
          candidateEmployeeId: 'e1',
          shiftAssignmentId: 's1',
          orgUnitId: 'o1',
        }),
      ).rejects.toBeInstanceOf(GuardrailValidationUnavailableError);

      const values = (await metrics.guardrailValidationTotal.get()).values;
      expect(values.find((v) => v.labels.result === 'unavailable')?.value).toBe(1);
    });
  });
});
