import { createHash, randomUUID } from 'node:crypto';
import { UserManagementController } from '../../src/modules/identity/rest/user-management.controller';
import { InviteTokenService } from '../../src/modules/identity/services/invite-token.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { TenantContextMissingError } from '../../src/common/tenant/tenant-context.errors';
import { EmailAlreadyInUseError } from '../../src/modules/identity/errors/email-already-in-use.error';
import { InvalidOrExpiredInviteError } from '../../src/modules/identity/errors/invalid-or-expired-invite.error';
import { UserNotFoundError } from '../../src/modules/identity/errors/user-not-found.error';
import { UserStatus } from '../../src/modules/identity/entities/user-status.enum';
import { RequestWithTokenClaims } from '../../src/modules/auth/rest/access-token.guard';

const TENANT_A = randomUUID();
const USER_ID = randomUUID();

function fakeRequest(): RequestWithTokenClaims {
  return { tokenClaims: { tenant_id: TENANT_A, sub: 'admin-1', permissions: [], roles: [] } } as never;
}

describe('UserManagementController', () => {
  let usersRepository: { findByEmail: jest.Mock; save: jest.Mock; update: jest.Mock; findOne: jest.Mock; count: jest.Mock };
  let systemLimits: { assertWithinLimit: jest.Mock };
  let userInvitesRepository: {
    create: jest.Mock;
    findByTokenHash: jest.Mock;
    markAccepted: jest.Mock;
    findPendingForUser: jest.Mock;
  };
  let userCredentialsRepository: { findByUserId: jest.Mock; update: jest.Mock };
  let passwordAuth: { setPassword: jest.Mock };
  let refreshTokens: { revokeAllSessionsForUser: jest.Mock };
  let auditLog: { record: jest.Mock };
  let tenantContext: TenantContextService;
  let controller: UserManagementController;

  beforeEach(() => {
    usersRepository = { findByEmail: jest.fn(), save: jest.fn(), update: jest.fn(), findOne: jest.fn(), count: jest.fn().mockResolvedValue(0) };
    systemLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    userInvitesRepository = {
      create: jest.fn(),
      findByTokenHash: jest.fn(),
      markAccepted: jest.fn(),
      findPendingForUser: jest.fn(),
    };
    userCredentialsRepository = { findByUserId: jest.fn(), update: jest.fn() };
    passwordAuth = { setPassword: jest.fn() };
    refreshTokens = { revokeAllSessionsForUser: jest.fn() };
    auditLog = { record: jest.fn() };
    // A real TenantContextService (own copy of every other spec's own
    // "use the real thing, it's cheap and pure" convention) - this suite's
    // whole point is proving the ambient-context plumbing is actually
    // correct, which a mock would hide.
    tenantContext = new TenantContextService();
    // Also real, not mocked - InviteTokenService is a thin wrapper over
    // userInvitesRepository (already mocked above), so every existing
    // assertion on userInvitesRepository.create's shape/tokenHash format
    // still exercises the real token-generation code, just one call deeper.
    const inviteTokenService = new InviteTokenService(userInvitesRepository as never);
    controller = new UserManagementController(
      usersRepository as never,
      userInvitesRepository as never,
      userCredentialsRepository as never,
      passwordAuth as never,
      refreshTokens as never,
      tenantContext,
      auditLog as never,
      inviteTokenService,
      systemLimits as never,
    );
  });

  describe('inviteUser', () => {
    it('creates an INVITED user, a hashed invite row, and an audit entry - never returning the raw token', async () => {
      usersRepository.findByEmail.mockResolvedValue(null);
      usersRepository.save.mockResolvedValue({ id: USER_ID, email: 'new@acme.example', status: UserStatus.INVITED });

      const result = await tenantContext.run({ tenantId: TENANT_A }, () =>
        controller.inviteUser(fakeRequest(), { email: 'new@acme.example' }),
      );

      expect(usersRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_A, email: 'new@acme.example', status: UserStatus.INVITED }),
      );
      expect(userInvitesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_A, userId: USER_ID, invitedEmail: 'new@acme.example' }),
      );
      const createCall = userInvitesRepository.create.mock.calls[0][0];
      expect(createCall.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(result)).not.toMatch(/tokenHash|rawToken/);
      expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.invited' }));
    });

    it('rejects an email that already has a User row, active or still-invited', async () => {
      usersRepository.findByEmail.mockResolvedValue({ id: 'existing', status: UserStatus.INVITED });

      await expect(
        tenantContext.run({ tenantId: TENANT_A }, () =>
          controller.inviteUser(fakeRequest(), { email: 'existing@acme.example' }),
        ),
      ).rejects.toThrow(EmailAlreadyInUseError);
      expect(usersRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('acceptInvite', () => {
    function validInvite() {
      return {
        id: 'invite-1',
        tenantId: TENANT_A,
        userId: USER_ID,
        tokenHash: 'irrelevant-for-these-mocks',
        invitedEmail: 'new@acme.example',
        expiresAt: new Date(Date.now() + 60_000),
        acceptedAt: null,
        createdAt: new Date(),
      };
    }

    it("sets the password, activates the user, and audits - all correctly scoped to the invite's own tenant with no ambient context bound beforehand", async () => {
      userInvitesRepository.findByTokenHash.mockResolvedValue(validInvite());

      // Deliberately NOT wrapped in tenantContext.run() here - this is the
      // exact pre-auth condition TenantContextMiddleware leaves an
      // accept-invite request in (no Bearer token, no X-Tenant-Id header).
      // If the controller relied on an already-bound ambient context
      // instead of establishing its own from invite.tenantId, every call
      // below would throw TenantContextMissingError.
      const result = await controller.acceptInvite({ token: 'raw-token-value', password: 'a-long-enough-password' });

      expect(result).toEqual({ accepted: true });
      expect(passwordAuth.setPassword).toHaveBeenCalledWith(USER_ID, TENANT_A, 'a-long-enough-password');
      expect(usersRepository.update).toHaveBeenCalledWith({ id: USER_ID }, { status: UserStatus.ACTIVE });
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_A, action: 'user.invite_accepted' }),
      );
      expect(userInvitesRepository.markAccepted).toHaveBeenCalledWith(expect.objectContaining({ id: 'invite-1' }));
    });

    it('hashes the presented token with SHA-256 before looking it up - the raw token is never queried directly', async () => {
      userInvitesRepository.findByTokenHash.mockResolvedValue(null);

      await expect(
        controller.acceptInvite({ token: 'some-raw-token', password: 'a-long-enough-password' }),
      ).rejects.toThrow(InvalidOrExpiredInviteError);

      const expectedHash = createHash('sha256').update('some-raw-token').digest('hex');
      expect(userInvitesRepository.findByTokenHash).toHaveBeenCalledWith(expectedHash);
    });

    it('rejects an unknown token', async () => {
      userInvitesRepository.findByTokenHash.mockResolvedValue(null);
      await expect(controller.acceptInvite({ token: 'bad', password: 'a-long-enough-password' })).rejects.toThrow(
        InvalidOrExpiredInviteError,
      );
      expect(passwordAuth.setPassword).not.toHaveBeenCalled();
    });

    it('rejects an expired invite', async () => {
      userInvitesRepository.findByTokenHash.mockResolvedValue({
        ...validInvite(),
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(controller.acceptInvite({ token: 'expired', password: 'a-long-enough-password' })).rejects.toThrow(
        InvalidOrExpiredInviteError,
      );
    });

    it('rejects an already-accepted invite (no replay)', async () => {
      userInvitesRepository.findByTokenHash.mockResolvedValue({ ...validInvite(), acceptedAt: new Date() });
      await expect(controller.acceptInvite({ token: 'reused', password: 'a-long-enough-password' })).rejects.toThrow(
        InvalidOrExpiredInviteError,
      );
      expect(passwordAuth.setPassword).not.toHaveBeenCalled();
    });
  });

  describe('revokeUserSession', () => {
    it('revokes all sessions for the target user and records an audit entry', async () => {
      usersRepository.findOne.mockResolvedValue({ id: USER_ID });

      const result = await tenantContext.run({ tenantId: TENANT_A }, () =>
        controller.revokeUserSession(fakeRequest(), USER_ID),
      );

      expect(result).toEqual({ revoked: true });
      expect(refreshTokens.revokeAllSessionsForUser).toHaveBeenCalledWith(USER_ID, 'admin_revoked');
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.sessions_revoked', resourceId: USER_ID }),
      );
    });

    it('rejects an unknown user id with a real 404, without calling revokeAllSessionsForUser', async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        tenantContext.run({ tenantId: TENANT_A }, () => controller.revokeUserSession(fakeRequest(), 'missing')),
      ).rejects.toThrow(UserNotFoundError);
      expect(refreshTokens.revokeAllSessionsForUser).not.toHaveBeenCalled();
    });
  });

  it('inviteUser throws TenantContextMissingError when called with no bound tenant context (sanity check on the ambient-context dependency itself)', async () => {
    usersRepository.findByEmail.mockResolvedValue(null);
    await expect(controller.inviteUser(fakeRequest(), { email: 'x@acme.example' })).rejects.toThrow(
      TenantContextMissingError,
    );
  });

  describe('getCredentialStatus', () => {
    it('reports credential state without ever exposing passwordHash', async () => {
      usersRepository.findOne.mockResolvedValue({ id: USER_ID });
      userCredentialsRepository.findByUserId.mockResolvedValue({
        passwordHash: 'bcrypt-hash-should-never-appear',
        passwordUpdatedAt: new Date('2026-01-01T00:00:00Z'),
        lockedUntil: null,
        failedLoginAttempts: 0,
      });
      userInvitesRepository.findPendingForUser.mockResolvedValue(null);

      const result = await tenantContext.run({ tenantId: TENANT_A }, () =>
        controller.getCredentialStatus(USER_ID),
      );

      expect(result).toEqual({
        hasPassword: true,
        passwordUpdatedAt: new Date('2026-01-01T00:00:00Z'),
        lockedUntil: null,
        failedLoginAttempts: 0,
        resetPending: false,
      });
      expect(JSON.stringify(result)).not.toMatch(/passwordHash|bcrypt-hash/);
    });

    it('reports hasPassword: false and resetPending: true when a reset link is outstanding and no credential exists yet', async () => {
      usersRepository.findOne.mockResolvedValue({ id: USER_ID });
      userCredentialsRepository.findByUserId.mockResolvedValue(null);
      userInvitesRepository.findPendingForUser.mockResolvedValue({ id: 'invite-1' });

      const result = await tenantContext.run({ tenantId: TENANT_A }, () =>
        controller.getCredentialStatus(USER_ID),
      );

      expect(result.hasPassword).toBe(false);
      expect(result.resetPending).toBe(true);
    });

    it('rejects an unknown user id with a real 404', async () => {
      usersRepository.findOne.mockResolvedValue(null);
      await expect(
        tenantContext.run({ tenantId: TENANT_A }, () => controller.getCredentialStatus('missing')),
      ).rejects.toThrow(UserNotFoundError);
    });
  });

  describe('setCredential', () => {
    it('sets the password directly and audits, without issuing any invite token', async () => {
      usersRepository.findOne.mockResolvedValue({ id: USER_ID });

      const result = await tenantContext.run({ tenantId: TENANT_A }, () =>
        controller.setCredential(fakeRequest(), USER_ID, { password: 'a-long-enough-password' }),
      );

      expect(result).toEqual({ set: true });
      expect(passwordAuth.setPassword).toHaveBeenCalledWith(USER_ID, TENANT_A, 'a-long-enough-password');
      expect(userInvitesRepository.create).not.toHaveBeenCalled();
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.credential_set', resourceId: USER_ID }),
      );
    });

    it('rejects an unknown user id without calling setPassword', async () => {
      usersRepository.findOne.mockResolvedValue(null);
      await expect(
        tenantContext.run({ tenantId: TENANT_A }, () =>
          controller.setCredential(fakeRequest(), 'missing', { password: 'a-long-enough-password' }),
        ),
      ).rejects.toThrow(UserNotFoundError);
      expect(passwordAuth.setPassword).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it("issues a fresh invite-style token for the existing user's own email and audits - never returning the raw token", async () => {
      usersRepository.findOne.mockResolvedValue({ id: USER_ID, email: 'existing@acme.example' });

      const result = await tenantContext.run({ tenantId: TENANT_A }, () =>
        controller.resetPassword(fakeRequest(), USER_ID),
      );

      expect(userInvitesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_A, userId: USER_ID, invitedEmail: 'existing@acme.example' }),
      );
      const createCall = userInvitesRepository.create.mock.calls[0][0];
      expect(createCall.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(result)).not.toMatch(/tokenHash|rawToken/);
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.password_reset_requested', resourceId: USER_ID }),
      );
    });

    it('rejects an unknown user id without issuing a token', async () => {
      usersRepository.findOne.mockResolvedValue(null);
      await expect(
        tenantContext.run({ tenantId: TENANT_A }, () => controller.resetPassword(fakeRequest(), 'missing')),
      ).rejects.toThrow(UserNotFoundError);
      expect(userInvitesRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('unlockAccount', () => {
    it('clears failedLoginAttempts and lockedUntil, and audits', async () => {
      usersRepository.findOne.mockResolvedValue({ id: USER_ID });

      const result = await tenantContext.run({ tenantId: TENANT_A }, () =>
        controller.unlockAccount(fakeRequest(), USER_ID),
      );

      expect(result).toEqual({ unlocked: true });
      expect(userCredentialsRepository.update).toHaveBeenCalledWith(
        { userId: USER_ID },
        { failedLoginAttempts: 0, lockedUntil: null },
      );
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.unlocked', resourceId: USER_ID }),
      );
    });

    it('rejects an unknown user id without touching the credential row', async () => {
      usersRepository.findOne.mockResolvedValue(null);
      await expect(
        tenantContext.run({ tenantId: TENANT_A }, () => controller.unlockAccount(fakeRequest(), 'missing')),
      ).rejects.toThrow(UserNotFoundError);
      expect(userCredentialsRepository.update).not.toHaveBeenCalled();
    });
  });
});
