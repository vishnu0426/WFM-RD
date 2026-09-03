import { EmploymentPoliciesService } from '../../src/modules/policy/services/employment-policies.service';
import { EmploymentPolicyViolatesComplianceFloorError } from '../../src/modules/policy/errors/employment-policy-violates-compliance-floor.error';
import { EmploymentPolicyType } from '../../src/modules/policy/entities/employment-policy-type.enum';

/**
 * §0.6/ADR-0101: `create`'s new compliance-floor gate. Direct construction
 * (no `Test.createTestingModule`), same pattern this repo's own
 * `auth-method-policy.service.spec.ts` already uses for a single-concern
 * service test.
 */
describe('EmploymentPoliciesService.create - compliance floor gate', () => {
  function build(overrides: {
    orgUnit?: { countryCode: string } | null;
    validateResult?: { valid: boolean; violations: string[]; floorNotFound: boolean };
    validateError?: Error;
  }) {
    const repository = {
      save: jest.fn((entity) => Promise.resolve(entity)),
      findOpenVersion: jest.fn(),
      update: jest.fn(),
    };
    const orgUnitsService = {
      findById: jest.fn().mockResolvedValue(overrides.orgUnit ?? { countryCode: 'US' }),
    };
    const tenantContext = {
      requireTenantId: jest.fn().mockReturnValue('tenant-1'),
    };
    const validatePolicyAgainstFloor = overrides.validateError
      ? jest.fn().mockRejectedValue(overrides.validateError)
      : jest.fn().mockResolvedValue(overrides.validateResult ?? { valid: true, violations: [], floorNotFound: false });
    const complianceGrpcClient = { validatePolicyAgainstFloor };

    const service = new EmploymentPoliciesService(
      repository as never,
      orgUnitsService as never,
      tenantContext as never,
      complianceGrpcClient as never,
    );
    return { service, repository, orgUnitsService, validatePolicyAgainstFloor };
  }

  const baseInput = {
    policyType: EmploymentPolicyType.REST_PERIOD_MINIMUM,
    orgUnitId: 'org-unit-1',
    definition: { minRestHoursBetweenShifts: 5 },
    effectiveFrom: '2026-01-01',
  };

  it('creates the policy when the floor validation passes', async () => {
    const { service, repository } = build({ validateResult: { valid: true, violations: [], floorNotFound: false } });
    await service.create(baseInput);
    expect(repository.save).toHaveBeenCalled();
  });

  it('rejects the write when the floor validation reports a real violation', async () => {
    const { service, repository } = build({
      validateResult: {
        valid: false,
        violations: ['minRestHoursBetweenShifts=5 is less protective...'],
        floorNotFound: false,
      },
    });
    await expect(service.create(baseInput)).rejects.toBeInstanceOf(EmploymentPolicyViolatesComplianceFloorError);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('allows the write when no floor exists for the jurisdiction (floorNotFound), even though valid is also true', async () => {
    const { service, repository } = build({ validateResult: { valid: true, violations: [], floorNotFound: true } });
    await service.create(baseInput);
    expect(repository.save).toHaveBeenCalled();
  });

  it("resolves jurisdiction from the org unit's own countryCode when input.jurisdiction is not supplied", async () => {
    const { service, validatePolicyAgainstFloor } = build({ orgUnit: { countryCode: 'GB' } });
    await service.create(baseInput);
    expect(validatePolicyAgainstFloor).toHaveBeenCalledWith(
      expect.objectContaining({ jurisdiction: 'GB', tenantId: 'tenant-1' }),
    );
  });

  it("prefers an explicit input.jurisdiction over the org unit's countryCode", async () => {
    const { service, validatePolicyAgainstFloor } = build({ orgUnit: { countryCode: 'US' } });
    await service.create({ ...baseInput, jurisdiction: 'US-CA' });
    expect(validatePolicyAgainstFloor).toHaveBeenCalledWith(expect.objectContaining({ jurisdiction: 'US-CA' }));
  });

  it('skips floor validation entirely (does not call the gRPC client) when no jurisdiction is resolvable at all', async () => {
    const { service, repository, validatePolicyAgainstFloor } = build({});
    await service.create({ ...baseInput, orgUnitId: undefined });
    expect(validatePolicyAgainstFloor).not.toHaveBeenCalled();
    expect(repository.save).toHaveBeenCalled();
  });

  it('fails closed - propagates a gRPC unavailability error rather than letting the write silently proceed', async () => {
    const { service, repository } = build({ validateError: new Error('compliance service unreachable') });
    await expect(service.create(baseInput)).rejects.toThrow('compliance service unreachable');
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('passes ruleType matching the policyType, and the policy definition as JSON', async () => {
    const { service, validatePolicyAgainstFloor } = build({});
    await service.create(baseInput);
    expect(validatePolicyAgainstFloor).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleType: EmploymentPolicyType.REST_PERIOD_MINIMUM,
        policyDefinitionJson: JSON.stringify({ minRestHoursBetweenShifts: 5 }),
      }),
    );
  });
});
