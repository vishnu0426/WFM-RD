import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { InvalidTenantIdError, TenantContextMissingError } from './tenant-context.errors';

export interface TenantContextStore {
  tenantId: string;
}

// Structural only (8-4-4-4-12 hex), not a strict RFC 4122 variant/version
// check - same deliberately permissive pattern every other service's own
// copy uses, for the same reason: this service's dev/test tenant ids don't
// set valid variant bits and would be wrongly rejected by the stricter form.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Own copy of the platform's `TenantContextService` (ADR-0039 precedent:
 * each service owns its client/context primitives rather than sharing
 * one). Backed by `AsyncLocalStorage` so the binding survives async/await
 * across a request without threading it through every function signature
 * by hand.
 *
 * Nothing in this phase's request path (there isn't one yet - schema/
 * migrations only) actually calls `run()`/`requireTenantId()`. This class
 * exists now, real and tested, so Phase 2's connector-framework mutations
 * have a proven context primitive to bind against rather than inventing it
 * under phase pressure later.
 */
@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantContextStore>();

  run<T>(store: TenantContextStore, callback: () => T): T {
    if (!UUID_PATTERN.test(store.tenantId)) {
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
}
