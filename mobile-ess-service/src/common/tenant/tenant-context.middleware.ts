import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TenantContextService } from './tenant-context.service';

/**
 * Binds `TenantContextService` from an `X-Tenant-Id` header, trusted as-is -
 * the same header-trust **placeholder** convention every other service's
 * `TenantContextMiddleware` in this platform started with (ADR-0014).
 * `mobile-app` already sends this header on every authorized call
 * (`src/api/client.ts`, Module 11 Phase 1). `TenantTokenMatchGuard`
 * (`src/auth/tenant-token-match.guard.ts`) cross-checks this against the
 * JWT's own `tenant_id` claim before anything sensitive runs - closing the
 * "spoofed header" half of this placeholder's risk, not the "header trust
 * exists at all" half (that remains the same platform-wide, disclosed gap).
 *
 * Deliberately does **not** reject a request with a missing/invalid header -
 * it just doesn't bind context, and anything that actually requires a
 * tenant (`TenantContextService.requireTenantId()`) fails closed at the
 * point of use. Lowercased before binding (Postgres returns `uuid` columns
 * in canonical lowercase; an uppercase caller would otherwise fail every
 * plain-JS tenant-match comparison, including `TenantTokenMatchGuard`'s own).
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
