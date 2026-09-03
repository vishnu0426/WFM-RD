import {
  DataSource,
  EntityManager,
  EntityTarget,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  ObjectLiteral,
} from 'typeorm';
import { TenantContextService } from './tenant-context.service';
import { TenantMismatchError } from './tenant-context.errors';
import { withTenantTransaction } from './with-tenant-transaction';

type TenantScoped = { tenantId: string };

/**
 * ADR-0002: the only sanctioned way application code touches a tenant-scoped
 * table. Every method requires a bound TenantContextService context (fails
 * closed via TenantContextMissingError otherwise), runs inside a transaction
 * that sets the RLS session variable, and forces every `where`/inserted
 * row's `tenantId` to match the bound context - a caller cannot pass a
 * different tenant's id through `where` or `save` even by accident, because
 * this class overwrites/merges it rather than trusting the argument.
 *
 * A facade over TypeORM's `Repository<T>` rather than a subclass: `Repository`
 * exposes ~30 methods, and re-guarding all of them individually would be far
 * more surface area to keep correct than a small, deliberately curated set of
 * tenant-safe operations. Entity-specific repositories extend this class to
 * add typed convenience methods (see e.g. a future UsersRepository).
 */
export abstract class TenantScopedRepository<T extends ObjectLiteral & TenantScoped> {
  protected constructor(
    protected readonly dataSource: DataSource,
    private readonly target: EntityTarget<T>,
    protected readonly tenantContext: TenantContextService,
  ) {}

  private withScope<R>(work: (manager: EntityManager, tenantId: string) => Promise<R>): Promise<R> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) => work(manager, tenantId));
  }

  async find(options: Omit<FindManyOptions<T>, 'where'> & { where?: FindOptionsWhere<T> } = {}): Promise<T[]> {
    return this.withScope((manager, tenantId) =>
      manager.getRepository(this.target).find({
        ...options,
        where: { ...(options.where ?? {}), tenantId } as FindOptionsWhere<T>,
      }),
    );
  }

  async findOne(options: Omit<FindOneOptions<T>, 'where'> & { where: FindOptionsWhere<T> }): Promise<T | null> {
    return this.withScope((manager, tenantId) =>
      manager.getRepository(this.target).findOne({
        ...options,
        where: { ...options.where, tenantId } as FindOptionsWhere<T>,
      }),
    );
  }

  async count(options: Omit<FindManyOptions<T>, 'where'> & { where?: FindOptionsWhere<T> } = {}): Promise<number> {
    return this.withScope((manager, tenantId) =>
      manager.getRepository(this.target).count({
        ...options,
        where: { ...(options.where ?? {}), tenantId } as FindOptionsWhere<T>,
      }),
    );
  }

  async save(entity: T): Promise<T> {
    return this.withScope((manager, tenantId) => {
      if (entity.tenantId && entity.tenantId !== tenantId) {
        throw new TenantMismatchError(tenantId, entity.tenantId);
      }
      entity.tenantId = tenantId;
      return manager.getRepository(this.target).save(entity);
    });
  }

  async update(where: FindOptionsWhere<T>, partial: Partial<T> & Partial<TenantScoped>): Promise<void> {
    await this.withScope(async (manager, tenantId) => {
      if (partial.tenantId && partial.tenantId !== tenantId) {
        throw new TenantMismatchError(tenantId, partial.tenantId);
      }
      await manager.getRepository(this.target).update({ ...where, tenantId } as FindOptionsWhere<T>, partial as never);
    });
  }

  async delete(where: FindOptionsWhere<T>): Promise<void> {
    await this.withScope(async (manager, tenantId) => {
      await manager.getRepository(this.target).delete({ ...where, tenantId } as FindOptionsWhere<T>);
    });
  }
}
