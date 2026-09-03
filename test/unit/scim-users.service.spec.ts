import { ScimUsersService } from '../../src/modules/scim/services/scim-users.service';
import { UserStatus } from '../../src/modules/identity/entities/user-status.enum';
import { ScimResourceNotFoundError } from '../../src/modules/scim/errors/scim-resource-not-found.error';

describe('ScimUsersService', () => {
  const makeUser = (overrides: Partial<{ id: string; status: UserStatus }> = {}) => ({
    id: overrides.id ?? 'user-1',
    tenantId: 'tenant-1',
    email: 'alice@example.com',
    externalIdpId: null,
    givenName: null,
    familyName: null,
    status: overrides.status ?? UserStatus.ACTIVE,
    mfaEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const makeDeps = (user: ReturnType<typeof makeUser>) => {
    const usersRepository = {
      findOne: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue(undefined),
      save: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
    };
    const refreshTokens = { revokeAllSessionsForUser: jest.fn().mockResolvedValue(undefined) };
    return { usersRepository, refreshTokens };
  };

  it('getOrFail throws ScimResourceNotFoundError when the user does not exist', async () => {
    const { usersRepository, refreshTokens } = makeDeps(makeUser());
    usersRepository.findOne.mockResolvedValue(null);
    const service = new ScimUsersService(usersRepository as never, refreshTokens as never);
    await expect(service.getOrFail('missing')).rejects.toThrow(ScimResourceNotFoundError);
  });

  it('applyPatch with a pathed replace on "active":false deactivates and force-revokes sessions', async () => {
    const user = makeUser({ status: UserStatus.ACTIVE });
    const { usersRepository, refreshTokens } = makeDeps(user);
    const service = new ScimUsersService(usersRepository as never, refreshTokens as never);

    await service.applyPatch('user-1', [{ op: 'replace', path: 'active', value: false }]);

    expect(usersRepository.update).toHaveBeenCalledWith({ id: 'user-1' }, { status: UserStatus.DISABLED });
    expect(refreshTokens.revokeAllSessionsForUser).toHaveBeenCalledWith('user-1', 'scim_deprovisioned');
  });

  it('applyPatch with a path-less replace object containing active:false also force-revokes', async () => {
    const user = makeUser({ status: UserStatus.ACTIVE });
    const { usersRepository, refreshTokens } = makeDeps(user);
    const service = new ScimUsersService(usersRepository as never, refreshTokens as never);

    await service.applyPatch('user-1', [{ op: 'Replace', value: { active: false } }]);

    expect(usersRepository.update).toHaveBeenCalledWith({ id: 'user-1' }, { status: UserStatus.DISABLED });
    expect(refreshTokens.revokeAllSessionsForUser).toHaveBeenCalledTimes(1);
  });

  it('applyPatch updating only name.givenName does not touch status or trigger revocation', async () => {
    const user = makeUser({ status: UserStatus.ACTIVE });
    const { usersRepository, refreshTokens } = makeDeps(user);
    const service = new ScimUsersService(usersRepository as never, refreshTokens as never);

    await service.applyPatch('user-1', [{ op: 'replace', path: 'name.givenName', value: 'Alicia' }]);

    expect(usersRepository.update).toHaveBeenCalledWith({ id: 'user-1' }, { givenName: 'Alicia' });
    expect(refreshTokens.revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('applyPatch replacing active:true on an already-inactive user does not (re-)revoke', async () => {
    const user = makeUser({ status: UserStatus.DISABLED });
    const { usersRepository, refreshTokens } = makeDeps(user);
    const service = new ScimUsersService(usersRepository as never, refreshTokens as never);

    await service.applyPatch('user-1', [{ op: 'replace', path: 'active', value: true }]);

    expect(refreshTokens.revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('deactivate() force-revokes sessions only when the user was previously active', async () => {
    const activeUser = makeUser({ status: UserStatus.ACTIVE });
    const { usersRepository, refreshTokens } = makeDeps(activeUser);
    const service = new ScimUsersService(usersRepository as never, refreshTokens as never);

    await service.deactivate('user-1');

    expect(usersRepository.update).toHaveBeenCalledWith({ id: 'user-1' }, { status: UserStatus.DISABLED });
    expect(refreshTokens.revokeAllSessionsForUser).toHaveBeenCalledWith('user-1', 'scim_deprovisioned');
  });

  it('deactivate() on an already-disabled user is a no-op for revocation', async () => {
    const disabledUser = makeUser({ status: UserStatus.DISABLED });
    const { usersRepository, refreshTokens } = makeDeps(disabledUser);
    const service = new ScimUsersService(usersRepository as never, refreshTokens as never);

    await service.deactivate('user-1');

    expect(refreshTokens.revokeAllSessionsForUser).not.toHaveBeenCalled();
  });
});
