import { PolicyManagementService } from '../../src/modules/policy/services/policy-management.service';
import { PolicyNotFoundError } from '../../src/modules/policy/errors/policy-not-found.error';
import { PolicyType } from '../../src/modules/policy/entities/policy-type.enum';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const POLICY_GROUP_ID = '22222222-2222-4222-8222-222222222222';
const ORG_UNIT_ID = '33333333-3333-4333-8333-333333333333';

function buildOpenVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'policy-1',
    policyGroupId: POLICY_GROUP_ID,
    policyType: PolicyType.GEOFENCE_BOUNDARY,
    orgUnitId: ORG_UNIT_ID,
    definition: {},
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
    version: 1,
    ...overrides,
  };
}

/**
 * Module 11 Gap 1 (docs/adr/0155's disclosed geofencing kill-switch gap,
 * closed generically for every `PolicyType`). Same direct-construction
 * pattern this repo's own `employment-policies.service.spec.ts` uses.
 */
describe('PolicyManagementService.deactivate', () => {
  function build(overrides: { openVersion?: ReturnType<typeof buildOpenVersion> | null; permitted?: boolean } = {}) {
    const openVersion = overrides.openVersion === undefined ? buildOpenVersion() : overrides.openVersion;
    const policiesRepository = {
      findOpenVersion: jest.fn().mockResolvedValue(openVersion),
      deactivate: jest.fn().mockResolvedValue({ ...(openVersion ?? {}), effectiveTo: new Date() }),
    };
    const abac = {
      assertPermittedForOrgUnit: jest.fn().mockResolvedValue(overrides.permitted ?? true),
    };
    const service = new PolicyManagementService(policiesRepository as never, abac as never);
    return { service, policiesRepository, abac };
  }

  it('checks ABAC for the lineage own org unit, then deactivates it', async () => {
    const { service, policiesRepository, abac } = build();

    await service.deactivate(ACTOR_ID, POLICY_GROUP_ID);

    expect(abac.assertPermittedForOrgUnit).toHaveBeenCalledWith(ACTOR_ID, 'policy', 'write', ORG_UNIT_ID);
    expect(policiesRepository.deactivate).toHaveBeenCalledWith(POLICY_GROUP_ID);
  });

  it('throws PolicyNotFoundError when the lineage has no open version', async () => {
    const { service, policiesRepository, abac } = build({ openVersion: null });

    await expect(service.deactivate(ACTOR_ID, POLICY_GROUP_ID)).rejects.toThrow(PolicyNotFoundError);
    expect(abac.assertPermittedForOrgUnit).not.toHaveBeenCalled();
    expect(policiesRepository.deactivate).not.toHaveBeenCalled();
  });

  it('propagates an ABAC rejection without deactivating', async () => {
    const { service, policiesRepository, abac } = build();
    abac.assertPermittedForOrgUnit = jest.fn().mockRejectedValue(new Error('forbidden'));

    await expect(service.deactivate(ACTOR_ID, POLICY_GROUP_ID)).rejects.toThrow('forbidden');
    expect(policiesRepository.deactivate).not.toHaveBeenCalled();
  });
});
