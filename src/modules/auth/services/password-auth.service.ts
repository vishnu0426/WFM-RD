import { Injectable } from '@nestjs/common';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { UserCredentialsRepository } from '../repositories/user-credentials.repository';
import { PasswordHasherService } from './password-hasher.service';
import { User } from '../../identity/entities/user.entity';
import { UserStatus } from '../../identity/entities/user-status.enum';
import { InvalidCredentialsError } from '../errors/invalid-credentials.error';
import { AccountLockedError } from '../errors/account-locked.error';
import { WeakPasswordError } from '../errors/weak-password.error';
import { TenantSettingsRepository } from '../../tenant-settings/repositories/tenant-settings.repository';

// §5.7's failure-handling requirement, applied to local password auth.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/**
 * ADR-0023's local password bootstrap authentication. Runs inside the
 * tenant context already bound from the resolved OAuth client
 * (`POST /oauth/authorize`) - `UsersRepository.findByEmail` is
 * tenant-scoped, so this can never authenticate a user against the wrong
 * tenant's row even if two tenants happen to have users sharing an email.
 */
@Injectable()
export class PasswordAuthService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly userCredentialsRepository: UserCredentialsRepository,
    private readonly passwordHasher: PasswordHasherService,
    private readonly tenantSettingsRepository: TenantSettingsRepository,
  ) {}

  /**
   * `identifier` is historically an email address (the DTO field is
   * literally named `username` even though it's only ever held an email -
   * see `AuthorizeRequestDto`'s own doc comment), but a tenant may now also
   * have set a real `User.username` (`PATCH /v1/users/:id/username`) - this
   * tries that case-insensitive lookup first and falls back to the existing
   * by-email one, so a user with a username can log in with either without
   * this endpoint's request shape changing at all.
   */
  async authenticate(identifier: string, password: string): Promise<User> {
    const user =
      (await this.usersRepository.findByUsername(identifier)) ?? (await this.usersRepository.findByEmail(identifier));
    if (!user || user.status !== UserStatus.ACTIVE) {
      // Same error as "wrong password" - do not reveal whether the account exists.
      throw new InvalidCredentialsError();
    }
    const credential = await this.userCredentialsRepository.findByUserId(user.id);
    if (!credential) {
      throw new InvalidCredentialsError();
    }
    if (credential.lockedUntil && credential.lockedUntil.getTime() > Date.now()) {
      throw new AccountLockedError(credential.lockedUntil);
    }

    const valid = await this.passwordHasher.verify(password, credential.passwordHash);
    if (!valid) {
      const attempts = credential.failedLoginAttempts + 1;
      const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null;
      await this.userCredentialsRepository.update(
        { userId: user.id } as never,
        { failedLoginAttempts: lockedUntil ? 0 : attempts, lockedUntil } as never,
      );
      if (lockedUntil) {
        throw new AccountLockedError(lockedUntil);
      }
      throw new InvalidCredentialsError();
    }

    // Always one update on a successful login (piggybacking `lastLoginAt`
    // onto the existing lockout-reset write rather than adding a second
    // round trip) - `failedLoginAttempts`/`lockedUntil` are idempotently
    // reset to their already-clear values on the common "no prior failures"
    // path, since nothing else touches this row on that path otherwise.
    await this.userCredentialsRepository.update(
      { userId: user.id } as never,
      { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() } as never,
    );
    return user;
  }

  /**
   * `TenantSettings.passwordMinLength`/`passwordRequireUppercase`/
   * `passwordRequireNumber`/`passwordRequireSymbol` used to be stored but
   * never consulted anywhere - every password went through the same
   * hardcoded floor regardless of what a tenant had configured. This is the
   * one real enforcement point: both `acceptInvite` and admin
   * `setCredential` funnel through `setPassword`, so checking here covers
   * every real password-setting path in one place. `getOrCreate()` reads
   * from the ambient tenant context (already correctly bound to `tenantId`
   * at every real call site), same as every other `TenantSettingsRepository`
   * consumer.
   */
  private async assertMeetsPasswordPolicy(plaintextPassword: string): Promise<void> {
    const policy = await this.tenantSettingsRepository.getOrCreate();
    const unmetRules: string[] = [];
    if (plaintextPassword.length < policy.passwordMinLength) {
      unmetRules.push(`at least ${policy.passwordMinLength} characters`);
    }
    if (policy.passwordRequireUppercase && !/[A-Z]/.test(plaintextPassword)) {
      unmetRules.push('at least one uppercase letter');
    }
    if (policy.passwordRequireNumber && !/[0-9]/.test(plaintextPassword)) {
      unmetRules.push('at least one number');
    }
    if (policy.passwordRequireSymbol && !/[^A-Za-z0-9]/.test(plaintextPassword)) {
      unmetRules.push('at least one symbol');
    }
    if (unmetRules.length > 0) {
      throw new WeakPasswordError(unmetRules);
    }
  }

  async setPassword(userId: string, tenantId: string, plaintextPassword: string): Promise<void> {
    await this.assertMeetsPasswordPolicy(plaintextPassword);
    const passwordHash = await this.passwordHasher.hash(plaintextPassword);
    const existing = await this.userCredentialsRepository.findByUserId(userId);
    if (existing) {
      await this.userCredentialsRepository.update(
        { userId } as never,
        { passwordHash, passwordUpdatedAt: new Date(), failedLoginAttempts: 0, lockedUntil: null } as never,
      );
      return;
    }
    await this.userCredentialsRepository.save({
      userId,
      tenantId,
      passwordHash,
      passwordAlgorithm: 'bcrypt',
      passwordUpdatedAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
    } as never);
  }
}
