import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { User } from '../entities/user.entity';

@Injectable()
export class UsersRepository extends TenantScopedRepository<User> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, User, tenantContext);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.findOne({ where: { email: email.toLowerCase() } as never });
  }

  /**
   * Case-insensitive per-tenant lookup by `username` - unlike `email`,
   * `username` isn't normalized to lowercase at the entity layer (see
   * `User.username`'s own doc comment), so this compares via `lower()` at
   * query time instead of relying on the stored value's casing, the same
   * way `uq_users_tenant_id_username_lower` enforces uniqueness.
   * `TenantScopedRepository.findOne` can't express a `lower()` comparison
   * (it only builds equality `where` clauses), so this goes through
   * `createQueryBuilder` directly, mirroring `RolesRepository.findByIdIncludingSystem`.
   */
  async findByUsername(username: string): Promise<User | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) =>
      manager
        .getRepository(User)
        .createQueryBuilder('u')
        .where('u.tenant_id = :tenantId', { tenantId })
        .andWhere('lower(u.username) = lower(:username)', { username })
        .getOne(),
    );
  }
}
