import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TenantContextService } from './tenant-context.service';

/**
 * Binds `TenantContextService` from an `X-Tenant-Id` header, trusted as-is -
 * the same header-trust **placeholder** convention every other service's
 * `TenantContextMiddleware` in this platform started with (ADR-0014). A real
 * fix needs either a shared JWT-verification library or a gRPC call to
 * Module 01's `IdentityService` - out of scope for this phase, same
 * explicit-assumption posture as every prior module's Phase 1.
 *
 * Deliberately does **not** reject a request with a missing/invalid header -
 * it just doesn't bind context, and anything that actually requires a
 * tenant (`TenantContextService.requireTenantId()`) fails closed at the
 * point of use.
 *
 * Lowercased before binding, same fix ADR-0106 (Module 08 Phase 7) records:
 * Postgres always returns a `uuid` column's value in canonical lowercase,
 * but this header is trusted verbatim and RFC 4122 uuids are
 * case-insensitive, so an uppercase caller would otherwise make a plain-JS
 * `tenantId1 !== tenantId2` ownership check silently and incorrectly reject
 * a caller's own rows as not found.
 *
 * Phase 4 (ADR-0084's `X-Actor-Id` pattern, own copy): also reads an
 * optional `X-Actor-Id` header, same trust model, same "don't reject, let
 * `requireActorId()` fail closed at the point of use" posture, and the same
 * lowercase normalization as `X-Tenant-Id` (this service's `createdBy`
 * column is also a `uuid`).
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly tenantContext: TenantContextService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const tenantId = req.headers['x-tenant-id'];
    if (!tenantId || Array.isArray(tenantId)) {
      next();
      return;
    }
    const actorIdHeader = req.headers['x-actor-id'];
    const actorId = actorIdHeader && !Array.isArray(actorIdHeader) ? actorIdHeader.toLowerCase() : undefined;
    this.tenantContext.run({ tenantId: tenantId.toLowerCase(), actorId }, () => next());
  }
}
