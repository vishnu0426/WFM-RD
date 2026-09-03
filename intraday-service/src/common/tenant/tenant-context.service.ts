import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { ActorContextMissingError, InvalidTenantIdError, TenantContextMissingError } from './tenant-context.errors';

export interface TenantContextStore {
  tenantId: string;
  /** Phase 5: optional - only `acknowledgeAlert` requires it (via `requireActorId()`); nothing before this phase needed an actor identity at all. */
  actorId?: string;
}

// Structural only (8-4-4-4-12 hex), not a strict RFC 4122 variant/version
// check - deliberately more permissive than `class-validator`'s
// `@IsUUID()`. This service's own dev/test tenant ids used throughout this
// service's local verification (e.g. `11111111-1111-1111-1111-111111111111`)
// don't set valid variant bits and would be wrongly rejected by the
// stricter pattern - not worth the surprise for a header-trust placeholder
// that's already explicitly not real auth (design doc assumption 1).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 4: own copy of the root app's `TenantContextService`
 * (`src/common/tenant/tenant-context.service.ts` there). Phase 5 widens
 * it to optionally also carry `actorId` (from `X-Actor-Id`) - the first
 * thing in this service (`acknowledgeAlert`) that needs to know *who*,
 * not just *which tenant*. Still no `actorType`/`isPlatformAdmin` - this
 * service has no platform-admin concept.
 * Backed by `AsyncLocalStorage` so the binding survives async/await across
 * a request without being threaded through every function signature by
 * hand, same reasoning as root's copy.
 *
 * Deliberately **not** used by the ingestion webhook path (§4.2) - that
 * resolves `tenantId` from the URL path + HMAC signature, a different
 * trust model entirely (server-to-server, not a dashboard client).
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

  requireActorId(): string {
    const store = this.als.getStore();
    if (!store?.actorId) {
      throw new ActorContextMissingError();
    }
    return store.actorId;
  }
}
