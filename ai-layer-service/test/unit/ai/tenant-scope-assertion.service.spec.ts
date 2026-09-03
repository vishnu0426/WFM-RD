import { TenantScopeAssertionService } from '../../../src/ai/tenant-scope-assertion.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { AuditGrpcClientService } from '../../../src/grpc/audit-grpc-client.service';
import { CrossTenantDataAssemblyError } from '../../../src/common/tenant/tenant-context.errors';

describe('TenantScopeAssertionService', () => {
  let metrics: MetricsService;
  let auditClient: { recordEvent: jest.Mock };
  let service: TenantScopeAssertionService;

  beforeEach(() => {
    metrics = new MetricsService();
    metrics.onModuleInit();
    auditClient = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    service = new TenantScopeAssertionService(metrics, auditClient as unknown as AuditGrpcClientService);
  });

  it('does not throw when every assembled fact matches the requesting tenant', async () => {
    await expect(
      service.assertSameTenant('tenant-a', [
        { sourceModule: 'scheduling', tenantId: 'tenant-a' },
        { sourceModule: 'forecasting', tenantId: 'tenant-a' },
      ]),
    ).resolves.toBeUndefined();
    expect(auditClient.recordEvent).not.toHaveBeenCalled();
  });

  it('throws CrossTenantDataAssemblyError when any assembled fact belongs to a different tenant', async () => {
    await expect(
      service.assertSameTenant('tenant-a', [{ sourceModule: 'scheduling', tenantId: 'tenant-b' }]),
    ).rejects.toThrow(CrossTenantDataAssemblyError);
  });

  it('records a tenant-scope-assertion-failure metric, tagged by the offending source module, on mismatch', async () => {
    const spy = jest.spyOn(metrics, 'recordTenantScopeAssertionFailure');
    await expect(
      service.assertSameTenant('tenant-a', [{ sourceModule: 'scheduling', tenantId: 'tenant-b' }]),
    ).rejects.toThrow();
    expect(spy).toHaveBeenCalledWith('scheduling');
  });

  it('writes a durable, queryable audit event (actor_type: system) before rejecting - a stdout log line alone is not enough (docs/adr/0118)', async () => {
    await expect(
      service.assertSameTenant('tenant-a', [{ sourceModule: 'scheduling', tenantId: 'tenant-b' }]),
    ).rejects.toThrow();
    expect(auditClient.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        actorType: 'system',
        action: 'security.cross_tenant_data_assembly_detected',
        resourceType: 'tenant_scope_assertion',
        resourceId: 'scheduling',
      }),
    );
  });

  it('rejects on the first mismatch even when a later fact in the list would have matched', async () => {
    await expect(
      service.assertSameTenant('tenant-a', [
        { sourceModule: 'scheduling', tenantId: 'tenant-b' },
        { sourceModule: 'forecasting', tenantId: 'tenant-a' },
      ]),
    ).rejects.toThrow(CrossTenantDataAssemblyError);
  });

  it('never crashes the assertion when the audit write itself fails - the rejection still happens (AuditGrpcClientService is itself best-effort)', async () => {
    auditClient.recordEvent.mockRejectedValueOnce(new Error('core unreachable'));
    await expect(
      service.assertSameTenant('tenant-a', [{ sourceModule: 'scheduling', tenantId: 'tenant-b' }]),
    ).rejects.toThrow(CrossTenantDataAssemblyError);
  });
});
