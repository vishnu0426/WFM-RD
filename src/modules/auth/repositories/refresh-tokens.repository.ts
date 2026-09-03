import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { RefreshToken } from '../entities/refresh-token.entity';
import { RefreshTokenStatus } from '../entities/refresh-token-status.enum';

type NewTokenInFamily = Omit<
  RefreshToken,
  'id' | 'createdAt' | 'status' | 'replacedById' | 'revokedAt' | 'revokedReason'
>;

@Injectable()
export class RefreshTokensRepository extends TenantScopedRepository<RefreshToken> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, RefreshToken, tenantContext);
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.findOne({ where: { tokenHash } as never });
  }

  /** Creates generation 1 of a brand-new family (first login / first token issuance for a session). */
  async createFamily(input: NewTokenInFamily): Promise<RefreshToken> {
    return this.save({
      ...input,
      id: uuidv4(),
      status: RefreshTokenStatus.ACTIVE,
      replacedById: null,
      revokedAt: null,
      revokedReason: null,
    } as RefreshToken);
  }

  /**
   * ADR-0025's rotation step, as a compare-and-swap: the `UPDATE ... WHERE
   * status = 'active'` only proceeds to insert the next generation if it
   * actually flipped a row (`affected > 0`). Two concurrent requests racing
   * to rotate the same token can never both win this CAS - exactly one
   * inserts the next generation, and the loser gets `null` back, which
   * `RefreshTokenService` treats identically to reuse (fail closed: an
   * indistinguishable-from-malicious race is handled the same as an actual
   * replay, rather than silently minting two valid "next" tokens for one
   * presented token).
   *
   * The next-generation row is inserted *before* the CAS update, not after:
   * `replaced_by_id` is FK-constrained
   * (`refresh_tokens_replaced_by_id_fkey`), so the row it points at has to
   * exist first - setting it to a not-yet-inserted id fails the constraint
   * immediately, even inside the same transaction (the constraint isn't
   * deferred). If the CAS below then loses the race, this speculative insert
   * still commits, but as an unused, same-family row the service layer's
   * `revokeFamily` call on the losing path immediately revokes - never
   * returned to any caller, so no raw token for it is ever issued.
   */
  async rotate(presentedTokenId: string, next: NewTokenInFamily): Promise<RefreshToken | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, async (manager) => {
      const newTokenId = uuidv4();
      const inserted = await manager.getRepository(RefreshToken).save({
        ...next,
        id: newTokenId,
        status: RefreshTokenStatus.ACTIVE,
        replacedById: null,
        revokedAt: null,
        revokedReason: null,
      });

      const result = await manager
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ status: RefreshTokenStatus.ROTATED, replacedById: newTokenId })
        .where('id = :presentedTokenId', { presentedTokenId })
        .andWhere('tenant_id = :tenantId', { tenantId })
        .andWhere('status = :active', { active: RefreshTokenStatus.ACTIVE })
        .execute();
      if (!result.affected) {
        return null;
      }
      return inserted;
    });
  }

  /**
   * ADR-0025's reuse response: revoke every non-revoked token in the family.
   * Called both when reuse of an already-rotated token is detected and on an
   * explicit logout/`POST /oauth/revoke`.
   */
  async revokeFamily(familyId: string, reason: string): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    await withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ status: RefreshTokenStatus.REVOKED, revokedAt: () => 'now()', revokedReason: reason })
        .where('tenant_id = :tenantId', { tenantId })
        .andWhere('family_id = :familyId', { familyId })
        .andWhere('status != :revoked', { revoked: RefreshTokenStatus.REVOKED })
        .execute(),
    );
  }

  /**
   * §5.7's "SCIM deprovisioning request for a user mid-session must force
   * session revocation" - every family, not just one, since a user can hold
   * several concurrent sessions (multiple devices/browsers). Returns the
   * `token_hash` of every row this flipped to `revoked` so the caller
   * (`RefreshTokenService.revokeAllSessionsForUser`) can also purge the
   * Redis fast-path cache for each - unlike `revokeFamily` (always called
   * with the one presented token's hash already in hand), this can touch
   * many families' currently-cached "active" entries at once.
   */
  async revokeAllForUser(userId: string, reason: string): Promise<string[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ status: RefreshTokenStatus.REVOKED, revokedAt: () => 'now()', revokedReason: reason })
        .where('tenant_id = :tenantId', { tenantId })
        .andWhere('user_id = :userId', { userId })
        .andWhere('status != :revoked', { revoked: RefreshTokenStatus.REVOKED })
        .returning(['token_hash'])
        .execute();
      return (result.raw as Array<{ token_hash: string }>).map((row) => row.token_hash);
    });
  }
}
