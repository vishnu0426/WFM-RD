import { GeofenceVerificationService } from '../../src/geofence/geofence-verification.service';
import { EmployeeGrpcClientUnavailableError } from '../../src/grpc/employee-grpc-client.service';
import { PolicyGrpcClientUnavailableError } from '../../src/grpc/policy-grpc-client.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222';
const ORG_UNIT_ID = '33333333-3333-4333-8333-333333333333';

const BOUNDARY_DEFINITION = {
  centerLatitude: 37.7749,
  centerLongitude: -122.4194,
  radiusMeters: 100,
  enforcement: 'soft',
};

function buildPolicyFound(definition: Record<string, unknown> = BOUNDARY_DEFINITION) {
  return {
    found: true,
    id: 'policy-1',
    policyGroupId: 'policy-1',
    policyType: 'geofence_boundary',
    orgUnitId: ORG_UNIT_ID,
    definitionJson: JSON.stringify(definition),
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: '',
    version: 1,
  };
}

const POLICY_NOT_FOUND = {
  found: false,
  id: '',
  policyGroupId: '',
  policyType: '',
  orgUnitId: '',
  definitionJson: '',
  effectiveFrom: '',
  effectiveTo: '',
  version: 0,
};

function buildContext() {
  const employeeGrpcClient = {
    getEmployeeOrgUnits: jest.fn().mockResolvedValue([{ employeeId: EMPLOYEE_ID, orgUnitId: ORG_UNIT_ID }]),
  };
  const policyGrpcClient = {
    getActivePolicy: jest.fn().mockResolvedValue(buildPolicyFound()),
  };
  const service = new GeofenceVerificationService(employeeGrpcClient as never, policyGrpcClient as never);
  return { employeeGrpcClient, policyGrpcClient, service };
}

describe('GeofenceVerificationService.getConfigForEmployee', () => {
  it('returns enabled=false when the employee has no resolvable org unit', async () => {
    const { employeeGrpcClient, service } = buildContext();
    employeeGrpcClient.getEmployeeOrgUnits = jest.fn().mockResolvedValue([]);

    const result = await service.getConfigForEmployee(TENANT_ID, EMPLOYEE_ID);

    expect(result).toEqual({ enabled: false });
  });

  it('returns enabled=false when no geofence_boundary policy exists for the org unit', async () => {
    const { policyGrpcClient, service } = buildContext();
    policyGrpcClient.getActivePolicy = jest.fn().mockResolvedValue(POLICY_NOT_FOUND);

    const result = await service.getConfigForEmployee(TENANT_ID, EMPLOYEE_ID);

    expect(result).toEqual({ enabled: false });
  });

  it('returns enabled=true with radiusMeters/enforcement but never the center coordinates', async () => {
    const { service } = buildContext();

    const result = await service.getConfigForEmployee(TENANT_ID, EMPLOYEE_ID);

    expect(result).toEqual({ enabled: true, radiusMeters: 100, enforcement: 'soft' });
    expect(result).not.toHaveProperty('centerLatitude');
    expect(result).not.toHaveProperty('centerLongitude');
  });

  it('fails open (enabled=false) when the employee gRPC client is unavailable', async () => {
    const { employeeGrpcClient, service } = buildContext();
    employeeGrpcClient.getEmployeeOrgUnits = jest
      .fn()
      .mockRejectedValue(new EmployeeGrpcClientUnavailableError('GetEmployeeOrgUnits', new Error('UNAVAILABLE')));

    const result = await service.getConfigForEmployee(TENANT_ID, EMPLOYEE_ID);

    expect(result).toEqual({ enabled: false });
  });

  it('fails open (enabled=false) when the policy gRPC client is unavailable', async () => {
    const { policyGrpcClient, service } = buildContext();
    policyGrpcClient.getActivePolicy = jest
      .fn()
      .mockRejectedValue(new PolicyGrpcClientUnavailableError(new Error('UNAVAILABLE')));

    const result = await service.getConfigForEmployee(TENANT_ID, EMPLOYEE_ID);

    expect(result).toEqual({ enabled: false });
  });

  it('fails open (enabled=false) when the policy definition is unparseable JSON', async () => {
    const { policyGrpcClient, service } = buildContext();
    policyGrpcClient.getActivePolicy = jest
      .fn()
      .mockResolvedValue({ ...buildPolicyFound(), definitionJson: 'not json' });

    const result = await service.getConfigForEmployee(TENANT_ID, EMPLOYEE_ID);

    expect(result).toEqual({ enabled: false });
  });

  it('fails open (enabled=false) when the policy definition has a missing/invalid radiusMeters', async () => {
    const { policyGrpcClient, service } = buildContext();
    policyGrpcClient.getActivePolicy = jest
      .fn()
      .mockResolvedValue(buildPolicyFound({ ...BOUNDARY_DEFINITION, radiusMeters: 'not-a-number' }));

    const result = await service.getConfigForEmployee(TENANT_ID, EMPLOYEE_ID);

    expect(result).toEqual({ enabled: false });
  });

  it('defaults enforcement to soft when the definition omits it', async () => {
    const { policyGrpcClient, service } = buildContext();
    const withoutEnforcement: Record<string, unknown> = { ...BOUNDARY_DEFINITION };
    delete withoutEnforcement.enforcement;
    policyGrpcClient.getActivePolicy = jest.fn().mockResolvedValue(buildPolicyFound(withoutEnforcement));

    const result = await service.getConfigForEmployee(TENANT_ID, EMPLOYEE_ID);

    expect(result).toEqual({ enabled: true, radiusMeters: 100, enforcement: 'soft' });
  });
});

describe('GeofenceVerificationService.evaluate', () => {
  it('returns enabled=false, verified=null, enforcement=null when geofencing is not configured', async () => {
    const { policyGrpcClient, service } = buildContext();
    policyGrpcClient.getActivePolicy = jest.fn().mockResolvedValue(POLICY_NOT_FOUND);

    const result = await service.evaluate(TENANT_ID, EMPLOYEE_ID, { latitude: 37.7749, longitude: -122.4194 });

    expect(result).toEqual({ enabled: false, verified: null, enforcement: null });
  });

  it('verifies true when the location is within the configured radius', async () => {
    const { service } = buildContext();

    const result = await service.evaluate(TENANT_ID, EMPLOYEE_ID, { latitude: 37.7749, longitude: -122.4194 });

    expect(result).toEqual({ enabled: true, verified: true, enforcement: 'soft' });
  });

  it('verifies false when the location is outside the configured radius', async () => {
    const { service } = buildContext();
    // ~13km away - well outside a 100m radius.
    const farAway = { latitude: 37.8044, longitude: -122.2712 };

    const result = await service.evaluate(TENANT_ID, EMPLOYEE_ID, farAway);

    expect(result).toEqual({ enabled: true, verified: false, enforcement: 'soft' });
  });

  it('treats a missing location as unverified (decline-is-unverified, ADR-0155)', async () => {
    const { service } = buildContext();

    const result = await service.evaluate(TENANT_ID, EMPLOYEE_ID, undefined);

    expect(result).toEqual({ enabled: true, verified: false, enforcement: 'soft' });
  });

  it('propagates the enforcement mode through to the evaluation result', async () => {
    const { policyGrpcClient, service } = buildContext();
    policyGrpcClient.getActivePolicy = jest
      .fn()
      .mockResolvedValue(buildPolicyFound({ ...BOUNDARY_DEFINITION, enforcement: 'hard' }));

    const result = await service.evaluate(TENANT_ID, EMPLOYEE_ID, undefined);

    expect(result.enforcement).toBe('hard');
  });
});
