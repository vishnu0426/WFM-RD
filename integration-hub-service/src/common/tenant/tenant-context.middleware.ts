import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TenantContextService } from './tenant-context.service';

/**
 * Binds `TenantContextService` from an `X-Tenant-Id` header, trusted as-is -
 * the same header-trust **placeholder** convention every other service's
 * copy still uses today (ADR-0014). A real fix needs either a shared
 * JWT-verification library or a gRPC call to Module 01's `IdentityService` -
 * out of scope for this phase, same explicit-assumption posture as every
 * prior module's Phase 1.
 *
 * Deliberately does **not** reject a request with a missing/invalid header -
 * it just doesn't bind context, and anything that actually requires a
 * tenant (`TenantContextService.requireTenantId()`) fails closed at the
 * point of use.
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
    this.tenantContext.run({ tenantId }, () => next());
  }
}
