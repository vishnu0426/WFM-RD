import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { TenantManagementController } from '../../src/modules/tenant/rest/tenant-management.controller';
import { InviteTokenService } from '../../src/modules/identity/services/invite-token.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { TenantNotFoundError } from '../../src/modules/tenant/errors/tenant-not-found.error';
import { TenantNotProvisioningError } from '../../src/modules/tenant/errors/tenant-not-provisioning.error';
import { EmailAlreadyInUseError } from '../../src/modules/identity/errors/email-already-in-use.error';
import { UserStatus } from '../../src/modules/identity/entities/user-status.enum';
import type { RequestWithTokenClaims } from '../../src/modules/auth/rest/access-token.guard';

const PLATFORM_ADMIN_TENANT = randomUUID();
const NEW_TENANT_ID = randomUUID();
const NEW_USER_ID = randomUUID();
const TENANT_ADMIN_ROLE_ID = randomUUID();

function fakeRequest(roles: string[]): RequestWithTokenClaims {
  return {
    tokenClaims: { tenant_id: PLATFORM_ADMIN_TENANT, sub: 'platform-admin-1', permissions: [], roles },
  } as never;
}

function provisioningTenant() {
  return { id: NEW_TENANT_ID, name: 'New Co', status: TenantStatus.PROVISIONING } as never;
}

describe('TenantManagementController.provisionAdmin', () => {
  let tenants: { findById: jest.Mock; update: jest.Mock };
  let auditLog: { record: jest.Mock };
  let usersRepository: { findByEmail: jest.Mock; save: jest.Mock };
  let userRolesRepository: { assign: jest.Mock };
  let rolesRepository: { findAllIncludingSystem: jest.Mock };
  let userInvitesRepository: { create: jest.Mock };
  let orgUnitsService: { create: jest.Mock; hasAnyOrgUnits: jest.Mock };
  let tenantSettingsService: { getSettings: jest.Mock; updateWfmDefaults: jest.Mock };
  let tenantContext: TenantContextService;
  let controller: TenantManagementController;

  beforeEach(() => {
    tenants = { findById: jest.fn(), update: jest.fn() };
    auditLog = { record: jest.fn() };
    usersRepository = { findByEmail: jest.fn(), save: jest.fn() };
    userRolesRepository = { assign: jest.fn() };
    rolesRepository = {
      findAllIncludingSystem: jest.fn().mockResolvedValue([
        { id: TENANT_ADMIN_ROLE_ID, name: 'tenant_admin', isSystemRole: true },
        { id: randomUUID(), name: 'platform_admin', isSystemRole: true },
      ]),
    };
    userInvitesRepository = { create: jest.fn() };
    orgUnitsService = { create: jest.fn(), hasAnyOrgUnits: jest.fn() };
    tenantSettingsService = { getSettings: jest.fn(), updateWfmDefaults: jest.fn() };
    // Real, same "cheap and pure, proves the ambient-context plumbing"
    // convention as user-management.controller.spec.ts.
    tenantContext = new TenantContextService();
    const inviteTokenService = new InviteTokenService(userInvitesRepository as never);
    controller = new TenantManagementController(
      tenants as never,
      auditLog as never,
      tenantContext,
      usersRepository as never,
      userRolesRepository as never,
      rolesRepository as never,
      inviteTokenService,
      orgUnitsService as never,
      tenantSettingsService as never,
    );
  });

  it('rejects a caller without the platform_admin role, even one holding tenant:write', async () => {
    await expect(
      controller.provisionAdmin(fakeRequest(['tenant_admin']), NEW_TENANT_ID, { email: 'admin@newco.example' }),
    ).rejects.toThrow(ForbiddenException);
    expect(tenants.findById).not.toHaveBeenCalled();
  });

  it('rejects an unknown tenant id', async () => {
    tenants.findById.mockResolvedValue(null);
    await expect(
      controller.provisionAdmin(fakeRequest(['platform_admin']), NEW_TENANT_ID, { email: 'admin@newco.example' }),
    ).rejects.toThrow(TenantNotFoundError);
  });

  it('rejects a tenant that is not awaiting provisioning', async () => {
    tenants.findById.mockResolvedValue({ id: NEW_TENANT_ID, status: TenantStatus.ACTIVE });
    await expect(
      controller.provisionAdmin(fakeRequest(['platform_admin']), NEW_TENANT_ID, { email: 'admin@newco.example' }),
    ).rejects.toThrow(TenantNotProvisioningError);
    expect(usersRepository.findByEmail).not.toHaveBeenCalled();
  });

  it('rejects an email already in use within the target tenant', async () => {
    tenants.findById.mockResolvedValue(provisioningTenant());
    usersRepository.findByEmail.mockResolvedValue({ id: randomUUID() });
    await expect(
      controller.provisionAdmin(fakeRequest(['platform_admin']), NEW_TENANT_ID, { email: 'admin@newco.example' }),
    ).rejects.toThrow(EmailAlreadyInUseError);
    expect(userRolesRepository.assign).not.toHaveBeenCalled();
  });

  it('creates the user, assigns tenant_admin, issues an invite token, activates the tenant, and audits under the new tenant', async () => {
    tenants.findById.mockResolvedValue(provisioningTenant());
    usersRepository.findByEmail.mockResolvedValue(null);
    usersRepository.save.mockResolvedValue({
      id: NEW_USER_ID,
      email: 'admin@newco.example',
      status: UserStatus.INVITED,
    });

    const result = await controller.provisionAdmin(fakeRequest(['platform_admin']), NEW_TENANT_ID, {
      email: 'admin@newco.example',
      givenName: 'Ada',
    });

    expect(usersRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: NEW_TENANT_ID, email: 'admin@newco.example', status: UserStatus.INVITED }),
    );
    expect(userRolesRepository.assign).toHaveBeenCalledWith(NEW_USER_ID, TENANT_ADMIN_ROLE_ID, null);
    expect(userInvitesRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: NEW_TENANT_ID, userId: NEW_USER_ID, invitedEmail: 'admin@newco.example' }),
    );
    expect(tenants.update).toHaveBeenCalledWith(NEW_TENANT_ID, { status: TenantStatus.ACTIVE });
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: NEW_TENANT_ID, // the new tenant's own audit trail, not the calling platform admin's
        action: 'tenant.admin_provisioned',
        resourceId: NEW_TENANT_ID,
      }),
    );
    expect(result.user.id).toBe(NEW_USER_ID);
    expect(JSON.stringify(result)).not.toMatch(/tokenHash|rawToken/);
  });
});
