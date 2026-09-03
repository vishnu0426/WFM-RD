import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { AuthorizationCode } from '../entities/authorization-code.entity';

@Injectable()
export class AuthorizationCodesRepository extends TenantScopedRepository<AuthorizationCode> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, AuthorizationCode, tenantContext);
  }

  /**
   * Atomic single-use consumption: `UPDATE ... WHERE consumed_at IS NULL`
   * both marks the code used and returns it in one round trip, so two
   * concurrent `/oauth/token` requests racing on the same code cannot both
   * observe `consumedAt IS NULL` and both succeed (RFC 6749 §4.1.2 requires
   * a code be exchanged exactly once - a second use must invalidate any
   * tokens already issued from the first, which is exactly what "only one
   * caller ever sees a successful consume" gives us for free).
   */
  async consume(codeHash: string): Promise<AuthorizationCode | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(AuthorizationCode)
        .set({ consumedAt: () => 'now()' })
        .where('code_hash = :codeHash', { codeHash })
        .andWhere('tenant_id = :tenantId', { tenantId })
        .andWhere('consumed_at IS NULL')
        .andWhere('expires_at > now()')
        .execute();
      if (!result.affected) {
        return null;
      }
      // Re-read through the repository (not `.returning('*')`'s raw, snake_case
      // rows) so the result is a properly camelCase-mapped entity instance.
      return manager.getRepository(AuthorizationCode).findOne({ where: { codeHash, tenantId } });
    });
  }
}
