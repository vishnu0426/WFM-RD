import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TenantContextService } from './tenant-context.service';

/**
 * Binds `TenantContextService` from an `X-Tenant-Id` header, trusted as-is -
 * the same header-trust **placeholder** convention every prior service's
 * Phase 1 uses (ADR-0014). A real fix needs either a shared
 * JWT-verification library or a gRPC call to Module 01's `IdentityService` -
 * out of scope for this phase.
 *
 * Deliberately does **not** reject a request with a missing/invalid header -
 * it just doesn't bind context, and anything that actually requires a
 * tenant (`TenantContextService.requireTenantId()`) fails closed at the
 * point of use.
 *
 * Phase 2 (ADR-0084): also reads an optional `X-Actor-Id` header - same
 * trust model, same "don't reject, let `requireActorId()` fail closed at
 * the point of use" posture, mirroring intraday-service's own `X-Actor-Id`
 * widening (ADR-0069). A request with a valid `X-Tenant-Id` but no
 * `X-Actor-Id` still binds tenant context fine; only mutations that need to
 * know *who* (`claimOpenShift`, `proposeSwap`, `submitBid`) call
 * `requireActorId()`.
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
    const actorId = actorIdHeader && !Array.isArray(actorIdHeader) ? actorIdHeader : undefined;
    this.tenantContext.run({ tenantId, actorId }, () => next());
  }
}
