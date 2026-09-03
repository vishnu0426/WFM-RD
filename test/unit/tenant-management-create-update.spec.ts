import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { TenantManagementController } from '../../src/modules/tenant/rest/tenant-management.controller';
import { InviteTokenService } from '../../src/modules/identity/services/invite-token.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { SlugAlreadyInUseError } from '../../src/modules/tenant/errors/slug-already-in-use.error';
import type { RequestWithTokenClaims } from '../../src/modules/auth/rest/access-token.guard';

const CALLER_TENANT = randomUUID();
const OTHER_TENANT = randomUUID();

function fakeRequest(roles: string[], tenantId = CALLER_TENANT): RequestWithTokenClaims {
  return { tokenClaims: { tenant_id: tenantId, sub: 'caller-1', permissions: [], roles } } as never;
}

describe('TenantManagementController.create', () => {
  let tenants: { findBySlug: jest.Mock; create: jest.Mock; findById: jest.Mock; update: jest.Mock };
  let auditLog: { record: jest.Mock };
  let controller: TenantManagementController;

  beforeEach(() => {
    tenants = { findBySlug: jest.fn().mockResolvedValue(null), create: jest.fn(), findById: jest.fn(), update: jest.fn() };
    auditLog = { record: jest.fn() };
    controller = new TenantManagementController(
      tenants as never,
      auditLog as never,
      new TenantContextService(),
      {} as never,
      {} as never,
      {} as never,
      new InviteTokenService({} as never),
      {} as never,
      {} as never,
    );
  });

  it('rejects a tenant_admin trying to create a top-level tenant (no parentTenantId)', async () => {
    await expect(
      controller.create(fakeRequest(['tenant_admin']), {
        name: 'Evil Co',
        slug: 'evil-co',
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
      } as never),
    ).rejects.toThrow(ForbiddenException);
    expect(tenants.create).not.toHaveBeenCalled();
  });

  it('rejects a tenant_admin trying to create a tenant under someone else’s tenant id', async () => {
    await expect(
      controller.create(fakeRequest(['tenant_admin']), {
        name: 'Evil Co',
        slug: 'evil-co',
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        parentTenantId: OTHER_TENANT,
      } as never),
    ).rejects.toThrow(ForbiddenException);
    expect(tenants.create).not.toHaveBeenCalled();
  });

  it('allows a tenant_admin to onboard a BPO child under their own tenant', async () => {
    tenants.create.mockResolvedValue({ id: randomUUID(), name: 'Child Co', tier: TenantTier.SMB, status: TenantStatus.PROVISIONING, slug: 'child-co' });
    await expect(
      controller.create(fakeRequest(['tenant_admin']), {
        name: 'Child Co',
        slug: 'child-co',
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        parentTenantId: CALLER_TENANT,
      } as never),
    ).resolves.toBeDefined();
    expect(tenants.create).toHaveBeenCalled();
  });

  it('allows a platform_admin to create a top-level tenant', async () => {
    tenants.create.mockResolvedValue({ id: randomUUID(), name: 'Top Co', tier: TenantTier.SMB, status: TenantStatus.PROVISIONING, slug: 'top-co' });
    await expect(
      controller.create(fakeRequest(['platform_admin']), {
        name: 'Top Co',
        slug: 'top-co',
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
      } as never),
    ).resolves.toBeDefined();
  });

  it('still rejects a duplicate slug for an otherwise-authorized caller', async () => {
    tenants.findBySlug.mockResolvedValue({ id: randomUUID() });
    await expect(
      controller.create(fakeRequest(['platform_admin']), {
        name: 'Dup Co',
        slug: 'dup-co',
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
      } as never),
    ).rejects.toThrow(SlugAlreadyInUseError);
  });
});

describe('TenantManagementController.update', () => {
  let tenants: { findById: jest.Mock; update: jest.Mock };
  let auditLog: { record: jest.Mock };
  let controller: TenantManagementController;
  const TARGET_TENANT = randomUUID();

  beforeEach(() => {
    tenants = {
      findById: jest.fn().mockResolvedValue({ id: TARGET_TENANT, name: 'Acme', tier: TenantTier.ENTERPRISE, status: TenantStatus.ACTIVE, dataResidencyRegion: 'us-east-1' }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    auditLog = { record: jest.fn() };
    controller = new TenantManagementController(
      tenants as never,
      auditLog as never,
      new TenantContextService(),
      {} as never,
      {} as never,
      {} as never,
      new InviteTokenService({} as never),
      {} as never,
      {} as never,
    );
  });

  it('rejects a non-platform_admin trying to change tier on their own tenant (self-service escalation)', async () => {
    await expect(
      controller.update(fakeRequest(['tenant_admin'], TARGET_TENANT), TARGET_TENANT, { tier: TenantTier.ENTERPRISE } as never),
    ).rejects.toThrow(ForbiddenException);
    expect(tenants.update).not.toHaveBeenCalled();
  });

  it('rejects a non-platform_admin trying to change status', async () => {
    await expect(
      controller.update(fakeRequest(['tenant_admin'], TARGET_TENANT), TARGET_TENANT, { status: TenantStatus.SUSPENDED } as never),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a non-platform_admin trying to change dataResidencyRegion', async () => {
    await expect(
      controller.update(fakeRequest(['tenant_admin'], TARGET_TENANT), TARGET_TENANT, { dataResidencyRegion: 'eu-west-1' } as never),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows a non-platform_admin to rename their own tenant', async () => {
    tenants.findById.mockResolvedValueOnce({ id: TARGET_TENANT, name: 'Acme', tier: TenantTier.ENTERPRISE, status: TenantStatus.ACTIVE });
    tenants.findById.mockResolvedValueOnce({ id: TARGET_TENANT, name: 'Acme Renamed', tier: TenantTier.ENTERPRISE, status: TenantStatus.ACTIVE });
    await expect(
      controller.update(fakeRequest(['tenant_admin'], TARGET_TENANT), TARGET_TENANT, { name: 'Acme Renamed' } as never),
    ).resolves.toBeDefined();
    expect(tenants.update).toHaveBeenCalledWith(TARGET_TENANT, { name: 'Acme Renamed' });
  });

  it('allows a platform_admin to change tier/status/dataResidencyRegion', async () => {
    await expect(
      controller.update(fakeRequest(['platform_admin']), TARGET_TENANT, { tier: TenantTier.SMB } as never),
    ).resolves.toBeDefined();
    expect(tenants.update).toHaveBeenCalledWith(TARGET_TENANT, { tier: TenantTier.SMB });
  });
});
