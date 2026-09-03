import { Injectable } from '@nestjs/common';
import { DataSource, IsNull, MoreThan } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { UserInvite } from '../entities/user-invite.entity';

export interface CreateUserInviteInput {
  tenantId: string;
  userId: string;
  tokenHash: string;
  invitedEmail: string;
  expiresAt: Date;
}

/**
 * Deliberately not a `TenantScopedRepository` subclass, same reason as
 * `TenantIdentityProvidersRepository` (its own doc comment): `findByTokenHash`
 * is the lookup `POST /v1/auth/accept-invite` uses, before any tenant
 * context can be bound - relies on `user_invites_select`'s open RLS policy.
 * Every write stays tenant-gated via `withTenantTransaction`.
 */
@Injectable()
export class UserInvitesRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Open, cross-tenant lookup by token hash - see class doc comment. Only ever called with a hash, never the raw token. */
  async findByTokenHash(tokenHash: string): Promise<UserInvite | null> {
    return this.dataSource.getRepository(UserInvite).findOne({ where: { tokenHash } });
  }

  async create(input: CreateUserInviteInput): Promise<UserInvite> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(UserInvite).save(manager.getRepository(UserInvite).create(input)),
    );
  }

  /** Called only after a successful `findByTokenHash` (pre-auth), so it binds the invite's own tenant for this one write rather than requiring an already-bound context. */
  async markAccepted(invite: UserInvite): Promise<void> {
    await withTenantTransaction(this.dataSource, { tenantId: invite.tenantId }, (manager) =>
      manager.getRepository(UserInvite).update({ id: invite.id }, { acceptedAt: new Date() }),
    );
  }

  /** Latest not-yet-accepted, not-yet-expired invite/reset-password token for this user, if any — backs the "reset pending" indicator in the admin Usernames panel. */
  async findPendingForUser(userId: string): Promise<UserInvite | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(UserInvite).findOne({
        where: { tenantId, userId, acceptedAt: IsNull(), expiresAt: MoreThan(new Date()) },
        order: { createdAt: 'DESC' },
      }),
    );
  }
}
