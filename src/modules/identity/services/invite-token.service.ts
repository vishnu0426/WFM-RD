import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { UserInvitesRepository } from '../repositories/user-invites.repository';

const INVITE_TOKEN_BYTES = 32;
const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Extracted from `UserManagementController`'s own former private method
 * (`inviteUser`/`resetPassword` both needed it) so `TenantManagementController`'s
 * new `provisionAdmin` endpoint can issue the identical kind of single-use
 * token without a third copy of this logic. Same disclosed "no email
 * provider configured" placeholder delivery every caller of this already
 * accepts — the raw token exists only in this call's memory and one log
 * line, never persisted, never returned to any caller. Redeemed, unchanged,
 * via `POST /v1/auth/accept-invite`.
 */
@Injectable()
export class InviteTokenService {
  private readonly logger = new Logger(InviteTokenService.name);

  constructor(private readonly userInvitesRepository: UserInvitesRepository) {}

  async issue(tenantId: string, userId: string, email: string): Promise<Date> {
    const rawToken = randomBytes(INVITE_TOKEN_BYTES).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS);
    await this.userInvitesRepository.create({
      tenantId,
      userId,
      tokenHash: hashToken(rawToken),
      invitedEmail: email,
      expiresAt,
    });
    this.logger.log(
      `[placeholder invite delivery] tenant=${tenantId} email=${email} ` +
        `acceptUrl=/accept-invite?token=${rawToken} expiresAt=${expiresAt.toISOString()}`,
    );
    return expiresAt;
  }
}
