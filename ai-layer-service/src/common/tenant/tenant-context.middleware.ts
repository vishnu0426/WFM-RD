import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TenantContextService } from './tenant-context.service';

/**
 * Binds `TenantContextService` from an `X-Tenant-Id` header, trusted as-is -
 * the same header-trust **placeholder** convention every other service's
 * `TenantContextMiddleware` in this platform started with (ADR-0014). A real
 * fix needs a gRPC call to Module 01's `IdentityService.ValidateToken`
 * (§5.1 itself is explicit that the AI Layer must not trust its own
 * assembly logic as the tenant boundary - the same reasoning extends one
 * step further back to how tenant identity enters this service at all, out
 * of scope for this phase, same explicit-assumption posture as every prior
 * module's Phase 1).
 *
 * Deliberately does **not** reject a request with a missing/invalid header -
 * it just doesn't bind context, and anything that actually requires a
 * tenant (`TenantContextService.requireTenantId()`) fails closed at the
 * point of use. Lowercased before binding - see ADR-0106's cross-service
 * precedent (Postgres always returns `uuid` columns in canonical lowercase;
 * an uppercase caller would otherwise fail every plain-JS tenant-match
 * comparison, including §5.1's own assertion).
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
    this.tenantContext.run({ tenantId: tenantId.toLowerCase() }, () => next());
  }
}
