import { createHash } from 'node:crypto';
import { Body, Controller, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';
import { PasswordAuthService } from '../../auth/services/password-auth.service';
import { RefreshTokenService } from '../../auth/services/refresh-token.service';
import { UserCredentialsRepository } from '../../auth/repositories/user-credentials.repository';
import { UsersRepository } from '../repositories/users.repository';
import { UserInvitesRepository } from '../repositories/user-invites.repository';
import { InviteTokenService } from '../services/invite-token.service';
import { User } from '../entities/user.entity';
import { UserStatus } from '../entities/user-status.enum';
import { SetUsernameDto } from '../dto/set-username.dto';
import { EmailAlreadyInUseError } from '../errors/email-already-in-use.error';
import { InvalidOrExpiredInviteError } from '../errors/invalid-or-expired-invite.error';
import { UserNotFoundError } from '../errors/user-not-found.error';
import { UserNotInvitedError } from '../errors/user-not-invited.error';
import { UsernameAlreadyInUseError } from '../errors/username-already-in-use.error';
import { SystemLimitsPolicyService } from '../../policy/services/system-limits-policy.service';

// Absolute technical floor only - matches `UpdateSecurityPolicyDto.passwordMinLength`'s
// own `@Min(8)`, since a tenant can never configure a policy weaker than this. The
// tenant's actual configured policy (which may require more than this) is now the
// real, imperative check in `PasswordAuthService.setPassword`/`assertMeetsPasswordPolicy` -
// this DTO-level check is just the fast, declarative rejection of anything that could
// never pass any tenant's policy.
const MIN_PASSWORD_LENGTH = 8;

export class InviteUserDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  givenName?: string;

  @IsOptional()
  @IsString()
  familyName?: string;
}

export class AcceptInviteDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  password!: string;
}

export class SetCredentialDto {
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  password!: string;
}

export interface CredentialStatusView {
  hasPassword: boolean;
  passwordUpdatedAt: Date | null;
  lockedUntil: Date | null;
  failedLoginAttempts: number;
  resetPending: boolean;
  lastLoginAt: Date | null;
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Frontend Phase 8 gap-fix (§4/§0): `inviteUser`/`revokeUserSession` were
 * both named in the spec's own documented mutation list but neither existed
 * anywhere in this codebase - `inviteUser` had no user-creation path at
 * all, `revokeUserSession` had no admin-facing endpoint even though
 * `RefreshTokenService.revokeAllSessionsForUser` already existed (used only
 * by SCIM deprovisioning, `ScimUsersService.forceRevokeSessions`).
 *
 * `inviteUser` deliberately does NOT go through `NotificationService.enqueue`
 * - that service fans out to a user's own opt-in `notification_preferences`
 * rows, which a brand-new invited user has none of yet (silently dropping
 * the one message that must always reach them). This platform has no real
 * email/SMS provider configured anywhere (`LoggingChannelAdapter`'s own doc
 * comment) - the invite link is logged directly here, same honest,
 * disclosed placeholder posture, not routed through a delivery mechanism
 * built for a different (preference-gated, best-effort) kind of message.
 *
 * Re-inviting an email that already has a `User` row (any status,
 * including a still-pending `invited` one) is rejected rather than
 * resent/overwritten via `inviteUser` itself - `POST /v1/users/:id/resend-invite`
 * below is the follow-up that scope cut called for, added once an
 * already-invited user's id is known rather than re-submitting its email.
 *
 * `revokeUserSession` reuses `RefreshTokenService.revokeAllSessionsForUser`
 * unchanged - the exact mechanism SCIM deprovisioning already trusts, now
 * also reachable from a real admin action, not a new revocation path.
 */
@Controller()
export class UserManagementController {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly userInvitesRepository: UserInvitesRepository,
    private readonly userCredentialsRepository: UserCredentialsRepository,
    private readonly passwordAuth: PasswordAuthService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly tenantContext: TenantContextService,
    private readonly auditLog: AuditLogRepository,
    private readonly inviteTokenService: InviteTokenService,
    private readonly systemLimits: SystemLimitsPolicyService,
  ) {}

  @Post('v1/users/invite')
  @UseGuards(AccessTokenGuard, PermissionsGuard)
  @RequirePermissions('user:write')
  async inviteUser(
    @Req() req: RequestWithTokenClaims,
    @Body() dto: InviteUserDto,
  ): Promise<{ user: User; expiresAt: Date }> {
    const tenantId = this.tenantContext.requireTenantId();
    const existing = await this.usersRepository.findByEmail(dto.email);
    if (existing) {
      throw new EmailAlreadyInUseError(dto.email);
    }
    const currentCount = await this.usersRepository.count({});
    await this.systemLimits.assertWithinLimit('maxUsers', currentCount);

    const user = await this.usersRepository.save({
      tenantId,
      email: dto.email,
      givenName: dto.givenName ?? null,
      familyName: dto.familyName ?? null,
      status: UserStatus.INVITED,
      mfaEnabled: false,
    } as never);

    const expiresAt = await this.inviteTokenService.issue(tenantId, user.id, dto.email);

    const claims = req.tokenClaims!;
    await this.auditLog.record({
      tenantId,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'user.invited',
      resourceType: 'user',
      resourceId: user.id,
      beforeState: null,
      afterState: { email: dto.email },
      aiRationale: null,
    });

    return { user, expiresAt };
  }

  /** Public - an invited user has no session yet. Guarded entirely by possession of the raw token, same trust model `POST /oauth/token`'s authorization_code exchange already uses. */
  @Post('v1/auth/accept-invite')
  async acceptInvite(@Body() dto: AcceptInviteDto): Promise<{ accepted: true }> {
    const invite = await this.userInvitesRepository.findByTokenHash(hashToken(dto.token));
    if (!invite || invite.acceptedAt !== null || invite.expiresAt.getTime() < Date.now()) {
      throw new InvalidOrExpiredInviteError();
    }

    // No tenant context is bound yet at this point (this is a pre-auth,
    // public endpoint - `TenantContextMiddleware` only binds one from a
    // valid Bearer token or an `X-Tenant-Id` header, neither of which an
    // invited user has). `PasswordAuthService.setPassword`/`UsersRepository.update`/
    // `AuditLogRepository.record` all read the *ambient* bound tenant via
    // `TenantContextService.requireTenantId()` regardless of any tenantId
    // value passed alongside - every one of them must run inside this one
    // `run()` scope, not just the repository call that looked most
    // obviously tenant-scoped.
    await this.tenantContext.run({ tenantId: invite.tenantId }, async () => {
      await this.passwordAuth.setPassword(invite.userId, invite.tenantId, dto.password);
      await this.usersRepository.update({ id: invite.userId } as never, { status: UserStatus.ACTIVE } as never);
      await this.auditLog.record({
        tenantId: invite.tenantId,
        actorId: invite.userId,
        actorType: AuditActorType.USER,
        action: 'user.invite_accepted',
        resourceType: 'user',
        resourceId: invite.userId,
        beforeState: null,
        afterState: { status: UserStatus.ACTIVE },
        aiRationale: null,
      });
    });
    await this.userInvitesRepository.markAccepted(invite);

    return { accepted: true };
  }

  @Post('v1/users/:id/revoke-sessions')
  @UseGuards(AccessTokenGuard, PermissionsGuard)
  @RequirePermissions('user:write')
  async revokeUserSession(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<{ revoked: true }> {
    // `RefreshTokensRepository.revokeAllForUser` already scopes its own
    // UPDATE to the caller's bound tenant (`TenantContextService.requireTenantId()`),
    // so a cross-tenant id can never revoke another tenant's sessions - this
    // check exists purely so a garbage/wrong-tenant id gets a real 404
    // instead of a silently-true no-op.
    const user = await this.usersRepository.findOne({ where: { id } as never });
    if (!user) {
      throw new UserNotFoundError(id);
    }
    await this.refreshTokens.revokeAllSessionsForUser(id, 'admin_revoked');

    const claims = req.tokenClaims!;
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'user.sessions_revoked',
      resourceType: 'user',
      resourceId: id,
      beforeState: null,
      afterState: null,
      aiRationale: null,
    });

    return { revoked: true };
  }

  /**
   * "Usernames" admin panel (frontend Security-group Phase 1): local
   * `UserCredential` status for a user, never including `passwordHash`.
   * `resetPending` surfaces whether an admin-issued reset link (below) is
   * still outstanding, so the panel can show "reset link sent" state
   * without persisting a separate flag.
   */
  @Get('v1/users/:id/credential-status')
  @UseGuards(AccessTokenGuard, PermissionsGuard)
  @RequirePermissions('user:read')
  async getCredentialStatus(@Param('id') id: string): Promise<CredentialStatusView> {
    const user = await this.usersRepository.findOne({ where: { id } as never });
    if (!user) {
      throw new UserNotFoundError(id);
    }
    const [credential, pendingInvite] = await Promise.all([
      this.userCredentialsRepository.findByUserId(id),
      this.userInvitesRepository.findPendingForUser(id),
    ]);
    return {
      hasPassword: credential !== null,
      passwordUpdatedAt: credential?.passwordUpdatedAt ?? null,
      lockedUntil: credential?.lockedUntil ?? null,
      failedLoginAttempts: credential?.failedLoginAttempts ?? 0,
      resetPending: pendingInvite !== null,
      lastLoginAt: credential?.lastLoginAt ?? null,
    };
  }

  /**
   * Admin sets a user's local password directly (vs. `resetPassword` below,
   * which sends a link the user redeems themselves). Reuses the exact same
   * `PasswordAuthService.setPassword` `acceptInvite` already trusts.
   *
   * Audit gap-fix: this used to leave `status: INVITED` untouched, so an
   * admin using this as a shortcut to finish provisioning someone (instead
   * of making them redeem the invite link themselves) produced a user who
   * still couldn't log in - `PasswordAuthService`'s own login check rejects
   * anything but `ACTIVE`. Same status transition `acceptInvite` already
   * performs, applied here too, and only for `INVITED` - a `DISABLED` user
   * getting a password reset stays `DISABLED` (an admin resetting their
   * password isn't the same act as un-disabling them).
   */
  @Put('v1/users/:id/credential')
  @UseGuards(AccessTokenGuard, PermissionsGuard)
  @RequirePermissions('user:write')
  async setCredential(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Body() dto: SetCredentialDto,
  ): Promise<{ set: true }> {
    const tenantId = this.tenantContext.requireTenantId();
    const user = await this.usersRepository.findOne({ where: { id } as never });
    if (!user) {
      throw new UserNotFoundError(id);
    }
    await this.passwordAuth.setPassword(id, tenantId, dto.password);
    if (user.status === UserStatus.INVITED) {
      await this.usersRepository.update({ id } as never, { status: UserStatus.ACTIVE } as never);
    }

    const claims = req.tokenClaims!;
    await this.auditLog.record({
      tenantId,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'user.credential_set',
      resourceType: 'user',
      resourceId: id,
      beforeState: null,
      afterState: null,
      aiRationale: null,
    });
    return { set: true };
  }

  /**
   * Admin-triggered "force password reset": issues the same kind of
   * single-use token `inviteUser` issues for a brand-new user, but for an
   * existing `ACTIVE` one. `POST /v1/auth/accept-invite` handles the
   * redemption unchanged - it just re-sets `status = ACTIVE`, a no-op for a
   * user who's already active - so no new public endpoint is needed.
   */
  @Post('v1/users/:id/reset-password')
  @UseGuards(AccessTokenGuard, PermissionsGuard)
  @RequirePermissions('user:write')
  async resetPassword(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<{ expiresAt: Date }> {
    const tenantId = this.tenantContext.requireTenantId();
    const user = await this.usersRepository.findOne({ where: { id } as never });
    if (!user) {
      throw new UserNotFoundError(id);
    }
    const expiresAt = await this.inviteTokenService.issue(tenantId, id, user.email);

    const claims = req.tokenClaims!;
    await this.auditLog.record({
      tenantId,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'user.password_reset_requested',
      resourceType: 'user',
      resourceId: id,
      beforeState: null,
      afterState: null,
      aiRationale: null,
    });
    return { expiresAt };
  }

  /**
   * Resends an invite for a user still sitting in `UserStatus.INVITED` -
   * the "resend invite" follow-up this controller's own doc comment
   * disclosed as a scope cut when `inviteUser` was first added (re-inviting
   * an email that already has a `User` row was rejected outright, with no
   * way to get a fresh link for a still-pending one). Reuses the exact same
   * `InviteTokenService.issue` call `inviteUser`/`resetPassword` already
   * trust, just for an existing user id instead of a newly-created one -
   * same `{ expiresAt }` response shape as `resetPassword`, since it's the
   * same "issue a token, don't email it" placeholder-delivery pattern.
   */
  @Post('v1/users/:id/resend-invite')
  @UseGuards(AccessTokenGuard, PermissionsGuard)
  @RequirePermissions('user:write')
  async resendInvite(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<{ expiresAt: Date }> {
    const tenantId = this.tenantContext.requireTenantId();
    const user = await this.usersRepository.findOne({ where: { id } as never });
    if (!user) {
      throw new UserNotFoundError(id);
    }
    if (user.status !== UserStatus.INVITED) {
      throw new UserNotInvitedError(id);
    }
    const expiresAt = await this.inviteTokenService.issue(tenantId, id, user.email);

    const claims = req.tokenClaims!;
    await this.auditLog.record({
      tenantId,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'user.invite_resent',
      resourceType: 'user',
      resourceId: id,
      beforeState: null,
      afterState: null,
      aiRationale: null,
    });
    return { expiresAt };
  }

  /** Clears a lockout — same `failedLoginAttempts`/`lockedUntil` reset `PasswordAuthService` already performs on a successful login. */
  @Post('v1/users/:id/unlock')
  @UseGuards(AccessTokenGuard, PermissionsGuard)
  @RequirePermissions('user:write')
  async unlockAccount(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<{ unlocked: true }> {
    const user = await this.usersRepository.findOne({ where: { id } as never });
    if (!user) {
      throw new UserNotFoundError(id);
    }
    await this.userCredentialsRepository.update(
      { userId: id } as never,
      { failedLoginAttempts: 0, lockedUntil: null } as never,
    );

    const claims = req.tokenClaims!;
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'user.unlocked',
      resourceType: 'user',
      resourceId: id,
      beforeState: null,
      afterState: null,
      aiRationale: null,
    });
    return { unlocked: true };
  }

  /**
   * Sets a user's login `username` (frontend Phase 8 follow-up) - a no-op
   * (skips the conflict check entirely) when the submitted value is
   * unchanged for this same user, so re-saving a profile screen without
   * editing the username field never spuriously 409s. Case-insensitive
   * per-tenant uniqueness, same posture as `EmailAlreadyInUseError`/
   * `uq_users_tenant_id_email` for `email`.
   */
  @Patch('v1/users/:id/username')
  @UseGuards(AccessTokenGuard, PermissionsGuard)
  @RequirePermissions('user:write')
  async setUsername(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Body() dto: SetUsernameDto,
  ): Promise<{ username: string }> {
    const tenantId = this.tenantContext.requireTenantId();
    const user = await this.usersRepository.findOne({ where: { id } as never });
    if (!user) {
      throw new UserNotFoundError(id);
    }
    if (dto.username !== user.username) {
      const existing = await this.usersRepository.findByUsername(dto.username);
      if (existing && existing.id !== id) {
        throw new UsernameAlreadyInUseError(dto.username);
      }
    }
    await this.usersRepository.update({ id } as never, { username: dto.username } as never);

    const claims = req.tokenClaims!;
    await this.auditLog.record({
      tenantId,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'user.username_set',
      resourceType: 'user',
      resourceId: id,
      beforeState: { username: user.username },
      afterState: { username: dto.username },
      aiRationale: null,
    });
    return { username: dto.username };
  }
}
