import { RoleManagementService } from '../../src/modules/identity/services/role-management.service';
import { RoleNotFoundError } from '../../src/modules/identity/errors/role-not-found.error';
import { SystemRoleImmutableError } from '../../src/modules/identity/errors/system-role-immutable.error';

describe('RoleManagementService', () => {
  const makeDeps = () => {
    const rolesRepository = {
      findAllForTenant: jest.fn(),
      findById: jest.fn(),
      findByIdIncludingSystem: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findUsersWithRole: jest.fn(),
    };
    const rolePermissionsRepository = {
      findForRole: jest.fn(),
      bind: jest.fn(),
      unbind: jest.fn(),
    };
    const permissionsRepository = { findAll: jest.fn() };
    const userRolesRepository = {
      find: jest.fn(),
      findForUser: jest.fn(),
      assign: jest.fn(),
      revoke: jest.fn(),
    };
    return { rolesRepository, rolePermissionsRepository, permissionsRepository, userRolesRepository };
  };

  const makeService = (deps: ReturnType<typeof makeDeps>) =>
    new RoleManagementService(
      deps.rolesRepository as never,
      deps.rolePermissionsRepository as never,
      deps.permissionsRepository as never,
      deps.userRolesRepository as never,
    );

  it('getRoleOrFail throws RoleNotFoundError when the role does not exist', async () => {
    const deps = makeDeps();
    deps.rolesRepository.findById.mockResolvedValue(null);
    const service = makeService(deps);
    await expect(service.getRoleOrFail('missing')).rejects.toThrow(RoleNotFoundError);
  });

  it('bindPermission validates the role exists before binding', async () => {
    const deps = makeDeps();
    deps.rolesRepository.findById.mockResolvedValue({ id: 'role-1', name: 'Supervisor' });
    const service = makeService(deps);

    await service.bindPermission('role-1', 'perm-1');

    expect(deps.rolePermissionsRepository.bind).toHaveBeenCalledWith('role-1', 'perm-1');
  });

  it('bindPermission fails without binding when the role does not exist', async () => {
    const deps = makeDeps();
    deps.rolesRepository.findById.mockResolvedValue(null);
    const service = makeService(deps);

    await expect(service.bindPermission('missing', 'perm-1')).rejects.toThrow(RoleNotFoundError);
    expect(deps.rolePermissionsRepository.bind).not.toHaveBeenCalled();
  });

  it('userIdsWithRole de-duplicates user ids across multiple assignment rows (e.g. tenant-wide + scoped)', async () => {
    const deps = makeDeps();
    deps.userRolesRepository.find.mockResolvedValue([
      { userId: 'user-1', scopeOrgUnitId: null },
      { userId: 'user-1', scopeOrgUnitId: 'org-unit-1' },
      { userId: 'user-2', scopeOrgUnitId: null },
    ]);
    const service = makeService(deps);

    const userIds = await service.userIdsWithRole('role-1');

    expect(userIds.sort()).toEqual(['user-1', 'user-2']);
  });

  it('assignRole validates the role exists (including system roles) before assigning', async () => {
    const deps = makeDeps();
    deps.rolesRepository.findByIdIncludingSystem.mockResolvedValue({ id: 'role-1', name: 'Supervisor' });
    deps.userRolesRepository.assign.mockResolvedValue({ userId: 'user-1', roleId: 'role-1', scopeOrgUnitId: 'org-1' });
    const service = makeService(deps);

    await service.assignRole('user-1', 'role-1', 'org-1');

    expect(deps.rolesRepository.findByIdIncludingSystem).toHaveBeenCalledWith('role-1');
    expect(deps.rolesRepository.findById).not.toHaveBeenCalled();
    expect(deps.userRolesRepository.assign).toHaveBeenCalledWith('user-1', 'role-1', 'org-1', null);
  });

  it('assignRole now succeeds for a system role id (deliberate behavior change) instead of 404ing', async () => {
    const deps = makeDeps();
    deps.rolesRepository.findByIdIncludingSystem.mockResolvedValue({
      id: 'system-role-1',
      name: 'tenant_admin',
      isSystemRole: true,
      tenantId: null,
    });
    deps.userRolesRepository.assign.mockResolvedValue({
      userId: 'user-1',
      roleId: 'system-role-1',
      scopeOrgUnitId: null,
    });
    const service = makeService(deps);

    await expect(service.assignRole('user-1', 'system-role-1', null)).resolves.toEqual({
      userId: 'user-1',
      roleId: 'system-role-1',
      scopeOrgUnitId: null,
    });
  });

  it('assignRole fails without assigning when the role does not exist at all (not even as a system role)', async () => {
    const deps = makeDeps();
    deps.rolesRepository.findByIdIncludingSystem.mockResolvedValue(null);
    const service = makeService(deps);

    await expect(service.assignRole('user-1', 'missing', null)).rejects.toThrow(RoleNotFoundError);
    expect(deps.userRolesRepository.assign).not.toHaveBeenCalled();
  });

  describe('updateRole', () => {
    it('updates a tenant-owned role and returns the refreshed row', async () => {
      const deps = makeDeps();
      deps.rolesRepository.findById.mockResolvedValue({ id: 'role-1', name: 'Supervisor', isSystemRole: false });
      deps.rolesRepository.findByIdIncludingSystem.mockResolvedValue({
        id: 'role-1',
        name: 'Senior Supervisor',
        isSystemRole: false,
      });
      const service = makeService(deps);

      const updated = await service.updateRole('role-1', { name: 'Senior Supervisor' });

      expect(deps.rolesRepository.update).toHaveBeenCalledWith('role-1', { name: 'Senior Supervisor' });
      expect(updated).toEqual({ id: 'role-1', name: 'Senior Supervisor', isSystemRole: false });
    });

    it('throws SystemRoleImmutableError instead of updating when the role is a system role', async () => {
      const deps = makeDeps();
      deps.rolesRepository.findById.mockResolvedValue({ id: 'role-1', name: 'tenant_admin', isSystemRole: true });
      const service = makeService(deps);

      await expect(service.updateRole('role-1', { name: 'Renamed' })).rejects.toThrow(SystemRoleImmutableError);
      expect(deps.rolesRepository.update).not.toHaveBeenCalled();
    });

    it('throws RoleNotFoundError when the role does not exist for this tenant', async () => {
      const deps = makeDeps();
      deps.rolesRepository.findById.mockResolvedValue(null);
      const service = makeService(deps);

      await expect(service.updateRole('missing', { name: 'X' })).rejects.toThrow(RoleNotFoundError);
      expect(deps.rolesRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('usersWithRole', () => {
    it('resolves the role (including system roles) then returns its user rows', async () => {
      const deps = makeDeps();
      deps.rolesRepository.findByIdIncludingSystem.mockResolvedValue({ id: 'role-1', name: 'Supervisor' });
      const rows = [
        { id: 'user-1', email: 'a@x.com', givenName: 'A', familyName: 'X', status: 'active', scopeOrgUnitId: null },
        {
          id: 'user-1',
          email: 'a@x.com',
          givenName: 'A',
          familyName: 'X',
          status: 'active',
          scopeOrgUnitId: 'org-1',
        },
      ];
      deps.rolesRepository.findUsersWithRole.mockResolvedValue(rows);
      const service = makeService(deps);

      await expect(service.usersWithRole('role-1')).resolves.toEqual(rows);
      expect(deps.rolesRepository.findByIdIncludingSystem).toHaveBeenCalledWith('role-1');
      expect(deps.rolesRepository.findUsersWithRole).toHaveBeenCalledWith('role-1');
    });

    it('throws RoleNotFoundError without querying users when the role does not exist', async () => {
      const deps = makeDeps();
      deps.rolesRepository.findByIdIncludingSystem.mockResolvedValue(null);
      const service = makeService(deps);

      await expect(service.usersWithRole('missing')).rejects.toThrow(RoleNotFoundError);
      expect(deps.rolesRepository.findUsersWithRole).not.toHaveBeenCalled();
    });
  });
});
