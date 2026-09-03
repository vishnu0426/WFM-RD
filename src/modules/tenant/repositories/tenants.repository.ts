import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, FindOptionsWhere } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { Tenant } from '../entities/tenant.entity';

/**
 * Not a TenantScopedRepository subclass: `Tenant` has no `tenant_id` column
 * (its own `id` IS the tenant identity), and its RLS predicate (ADR-0007) is
 * a three-way self/BPO-child/platform-admin check, not simple `tenant_id`
 * equality - duplicating that predicate in application code would just be a
 * second copy to keep in sync with the migration. This class binds the two
 * session GUCs (via `withTenantTransaction`) and otherwise defers entirely
 * to RLS for authorization; unlike `TenantScopedRepository`, it does not
 * additionally validate `where`/entity values client-side - a caller
 * attempting something RLS disallows gets zero rows (reads) or a Postgres
 * row-level-security error (writes), not a pre-empted app-level rejection.
 */
@Injectable()
export class TenantsRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  private withScope<R>(work: (manager: EntityManager) => Promise<R>): Promise<R> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, work);
  }

  /** The caller's own tenant row - RLS always allows `id = current_tenant_id`. */
  async findSelf(): Promise<Tenant | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.withScope((manager) => manager.getRepository(Tenant).findOne({ where: { id: tenantId } }));
  }

  /**
   * Direct BPO children of `parentTenantId`. If the caller isn't a platform
   * admin and `parentTenantId` isn't their own tenant, RLS returns zero rows
   * regardless of what's asked for - the WHERE clause and the RLS predicate
   * both have to hold for a row to come back.
   */
  async findChildren(parentTenantId: string): Promise<Tenant[]> {
    return this.withScope((manager) => manager.getRepository(Tenant).find({ where: { parentTenantId } }));
  }

  async findById(id: string): Promise<Tenant | null> {
    return this.withScope((manager) => manager.getRepository(Tenant).findOne({ where: { id } }));
  }

  /**
   * Slug is globally unique, not per-tenant - `withScope`'s RLS-bound
   * connection still works fine here since `uq_tenants_slug` (partial,
   * `WHERE slug IS NOT NULL`) is a plain cross-tenant index, and a
   * platform_admin session's RLS bypass means this genuinely searches
   * every tenant, not just the caller's own visibility scope.
   */
  async findBySlug(slug: string): Promise<Tenant | null> {
    return this.withScope((manager) => manager.getRepository(Tenant).findOne({ where: { slug } }));
  }

  /**
   * Every tenant in the system - only meaningful for a platform-admin
   * session. No `WHERE` clause; `tenants_select`'s own `USING` clause is
   * what actually does the work here (`is_platform_admin OR id =
   * current_tenant_id OR parent_tenant_id = current_tenant_id`) - for a
   * platform admin the first disjunct is unconditionally true, so a plain
   * `find()` returns every row. For anyone else this degrades to "my own
   * tenant plus my direct children," the same set `findChildren` on one's
   * own tenant already returns - not a data leak, just a confusingly-named
   * method to call from that context, which is why the controller route
   * this backs is itself platform-admin-gated.
   */
  async findAll(): Promise<Tenant[]> {
    return this.withScope((manager) => manager.getRepository(Tenant).find());
  }

  /**
   * Onboards a child tenant under the caller's own tenant (BPO multi-client
   * onboarding), or - for a platform-admin session - any tenant, including a
   * new top-level one (`parentTenantId: null`). The `tenants_insert` RLS
   * policy is the actual gate; a disallowed attempt surfaces as a Postgres
   * row-level-security violation, not a TypeScript-level pre-check.
   */
  async create(tenant: Omit<Tenant, 'id' | 'createdAt' | 'updatedAt'>): Promise<Tenant> {
    return this.withScope((manager) => manager.getRepository(Tenant).save(tenant as Tenant));
  }

  /** Update self or a direct BPO child; platform admins may update any tenant. Gated by `tenants_update` RLS. */
  async update(id: string, partial: Partial<Tenant>): Promise<void> {
    await this.withScope(async (manager) => {
      await manager.getRepository(Tenant).update({ id } as FindOptionsWhere<Tenant>, partial as never);
    });
  }
}
