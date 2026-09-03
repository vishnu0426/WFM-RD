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
 * Lowercased before binding - a real bug found in Phase 7's own real E2E
 * verification (docs/adr/0106): Postgres always returns a `uuid` column's
 * value in canonical lowercase, but this header is trusted verbatim
 * (ADR-0014) and RFC 4122 uuids are case-insensitive, so an uppercase
 * caller (macOS `uuidgen`'s own default form, among others) made every
 * plain-JS `tenantId1 !== tenantId2` ownership check in this service
 * (`ComplianceReportService.getOwnedReport`, `ComplianceRuleService.getOwnedRule`/
 * `activateRule`) silently and incorrectly reject a caller's own rows as
 * not found - RLS itself was never affected (`::uuid` casts normalize case
 * for the SQL comparison), only this service's own application-level
 * string comparisons were. Normalizing once, here, at the single boundary
 * where external input enters the system, fixes every comparison site at
 * once rather than patching each one.
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
