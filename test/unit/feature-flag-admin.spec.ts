import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { FeatureFlagAdminController } from '../../src/modules/tenant/rest/feature-flag-admin.controller';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import type { RequestWithTokenClaims } from '../../src/modules/auth/rest/access-token.guard';

const TENANT_ID = randomUUID();

function fakeRequest(roles: string[]): RequestWithTokenClaims {
  return { tokenClaims: { tenant_id: randomUUID(), sub: 'caller-1', permissions: [], roles } } as never;
}

describe('FeatureFlagAdminController.setForTenant', () => {
  let featureFlagsRepository: { findAllForKey: jest.Mock };
  let featureFlagsService: { isEnabled: jest.Mock; setEnabled: jest.Mock };
  let tenants: { findAll: jest.Mock };
  let auditLog: { record: jest.Mock };
  let controller: FeatureFlagAdminController;

  beforeEach(() => {
    featureFlagsRepository = { findAllForKey: jest.fn() };
    featureFlagsService = { isEnabled: jest.fn().mockResolvedValue(false), setEnabled: jest.fn().mockResolvedValue(true) };
    tenants = { findAll: jest.fn() };
    auditLog = { record: jest.fn() };
    controller = new FeatureFlagAdminController(
      featureFlagsRepository as never,
      featureFlagsService as never,
      tenants as never,
      new TenantContextService(),
      auditLog as never,
    );
  });

  it('rejects a non-platform_admin', async () => {
    await expect(
      controller.setForTenant(fakeRequest(['tenant_admin']), 'bulk_import_destructive', TENANT_ID, { enabled: true }),
    ).rejects.toThrow(ForbiddenException);
    expect(featureFlagsService.setEnabled).not.toHaveBeenCalled();
  });

  it('records an audit entry with before/after state under the target tenant', async () => {
    const result = await controller.setForTenant(fakeRequest(['platform_admin']), 'bulk_import_destructive', TENANT_ID, { enabled: true });

    expect(featureFlagsService.setEnabled).toHaveBeenCalledWith('bulk_import_destructive', true);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        action: 'feature_flag.changed',
        resourceType: 'feature_flag',
        resourceId: null,
        beforeState: { flagKey: 'bulk_import_destructive', enabled: false },
        afterState: { flagKey: 'bulk_import_destructive', enabled: true },
      }),
    );
    expect(result).toEqual({ tenantId: TENANT_ID, flagKey: 'bulk_import_destructive', enabled: true });
  });
});
