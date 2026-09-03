import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TenantContextService } from './tenant-context.service';

/**
 * Phase 4: binds `TenantContextService` from an `X-Tenant-Id` header,
 * trusted as-is - the same header-trust **placeholder** convention root's
 * own `TenantContextMiddleware` started with (ADR-0014) before real JWT
 * verification closed the gap (ADR-0049), and the same convention
 * scheduling-service's REST API still uses today. A real fix needs either
 * a shared JWT-verification library or a gRPC call to Module 01's
 * `IdentityService` - out of scope for this phase (design doc's explicit
 * assumption 1).
 *
 * Deliberately does **not** reject a request with a missing/invalid
 * header - it just doesn't bind context, and anything that actually
 * requires a tenant (`TenantContextService.requireTenantId()`) fails
 * closed at the point of use. This lets the middleware apply broadly
 * (every route) without interfering with the ingestion webhook's own,
 * different tenant-resolution path (§4.2 - URL path + HMAC), which never
 * calls `requireTenantId()` at all.
 *
 * Phase 5: also reads an optional `X-Actor-Id` header - same trust model,
 * same "don't reject, let `requireActorId()` fail closed at the point of
 * use" posture. A request with a valid `X-Tenant-Id` but no `X-Actor-Id`
 * still binds tenant context fine; only `acknowledgeAlert` actually needs
 * an actor.
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
