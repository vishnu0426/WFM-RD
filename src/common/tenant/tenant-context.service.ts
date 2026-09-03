import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { validate as isUuid } from 'uuid';
import { InvalidTenantIdError, TenantContextMissingError } from './tenant-context.errors';

export type ActorType = 'user' | 'system' | 'ai_agent';

export interface TenantContextStore {
  tenantId: string;
  actorId?: string;
  actorType?: ActorType;
  /**
   * ADR-0007: additive escape hatch for cross-tenant platform-admin
   * operations on `core.tenants` (e.g. `POST /v1/tenants`). Never a
   * replacement for `tenantId` - a platform-admin session still binds a
   * tenant (its home/platform tenant) so every other tenant-scoped table's
   * RLS keeps working unchanged. Must only ever be set from a validated
   * identity (e.g. a `platform_admin` role claim in a verified JWT), never
   * from client-supplied input.
   */
  isPlatformAdmin?: boolean;
}

/**
 * ADR-0002: the single source of truth for "which tenant is this operation
 * scoped to." Backed by Node's AsyncLocalStorage so the binding survives
 * async/await across a request or job without being threaded through every
 * function signature by hand, and so unrelated concurrent requests never
 * observe each other's tenant id.
 *
 * Nothing outside `run()` can set the store - there is no public setter -
 * so the only way a tenant id enters the system is through whatever code
 * calls `run()` at the top of a request/job (a controller guard in later
 * phases; a seed script or test harness directly in Phase 1).
 */
@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantContextStore>();

  run<T>(store: TenantContextStore, callback: () => T): T {
    if (!isUuid(store.tenantId)) {
      throw new InvalidTenantIdError(store.tenantId);
    }
    return this.als.run(store, callback);
  }

  getStore(): TenantContextStore | undefined {
    return this.als.getStore();
  }

  requireTenantId(): string {
    const store = this.als.getStore();
    if (!store?.tenantId) {
      throw new TenantContextMissingError();
    }
    return store.tenantId;
  }

  isPlatformAdmin(): boolean {
    return this.als.getStore()?.isPlatformAdmin ?? false;
  }
}
