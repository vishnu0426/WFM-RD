import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ActorType, TenantContextService } from '../tenant/tenant-context.service';
import { TokenService } from '../../modules/auth/services/token.service';

const VALID_ACTOR_TYPES: ReadonlySet<string> = new Set<ActorType>(['user', 'system', 'ai_agent']);

/**
 * Phase 7 (ADR-0049): binds `TenantContextService` from a validated JWT
 * (`Authorization: Bearer`) when one is present - `tenantId`/`actorId` come
 * from `claims.tenant_id`/`claims.sub`, `actorType` is inferred (`'system'`
 * for a `client_credentials` token, `sub` starting with `client:` - see
 * `OAuthController.handleClientCredentialsGrant`'s doc comment - `'user'`
 * otherwise), and `isPlatformAdmin` comes from `claims.roles.includes('platform_admin')`
 * - a real role claim inside a signed token, not a client-supplied header.
 * This closes the cross-tenant bypass ADR-0007/ADR-0014 flagged as an open
 * gap since Phase 1: previously, any caller holding *any* valid access
 * token - regardless of which tenant it was issued for - could forge
 * `X-Tenant-Id`/`X-Platform-Admin` headers and have every downstream
 * `TenantScopedRepository` call execute against a *different* tenant's RLS
 * context, as long as their JWT's flat `permissions` claim happened to
 * satisfy whatever `@RequirePermissions(...)` the endpoint required (RBAC
 * permission strings are not themselves tenant-scoped, so this was a real,
 * exploitable escape from tenant isolation for any RBAC-gated endpoint that
 * doesn't independently re-derive its own tenant id, which describes every
 * Module 01 controller/resolver added from Phase 4 onward - Module 02's
 * pre-Phase-4, ungated endpoints and Module 01's own pre-auth endpoints
 * (`POST /oauth/token`, SSO login initiation, ...) were never at risk here,
 * since they either trust nothing but a signed JWT to begin with or
 * explicitly re-derive their own tenant id from a `client_id`/provider
 * lookup inside the handler regardless of what this middleware bound).
 *
 * **Falls back to ADR-0014's original header-trust placeholder** only when
 * no `Authorization: Bearer` header is present, or the token fails
 * signature/`iss`/`aud`/`exp` verification. This is deliberately still
 * insecure by construction for that fallback case (see ADR-0014,
 * unchanged) - but every endpoint that actually matters for cross-tenant
 * safety already requires `AccessTokenGuard`, which independently
 * re-verifies the same token (including revocation, which this middleware
 * does NOT check - see ADR-0049's consequences) and rejects an
 * absent/invalid one with 401 before any repository call runs, regardless
 * of what tenant context this middleware bound. The fallback path's actual
 * remaining exposure is therefore limited to endpoints with no guard at
 * all (Module 02's pre-Phase-4 surface, unchanged risk from before this
 * phase) and pre-auth flows that explicitly re-bind their own tenant id
 * anyway.
 *
 * Deliberately Express middleware, not a Nest `Interceptor` - see ADR-0014
 * for why (GraphQL `@ResolveField`s don't re-enter Nest's interceptor
 * pipeline; Express middleware runs upstream of all of it and
 * `AsyncLocalStorage` correctly follows every async continuation
 * regardless).
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly tokenService: TokenService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length);
      try {
        const claims = await this.tokenService.verifyAccessToken(token);
        const actorType: ActorType = claims.sub.startsWith('client:') ? 'system' : 'user';
        const isPlatformAdmin = claims.roles.includes('platform_admin');
        this.tenantContext.run({ tenantId: claims.tenant_id, actorId: claims.sub, actorType, isPlatformAdmin }, () =>
          next(),
        );
        return;
      } catch {
        // Invalid/expired/unverifiable token - fall through to the header
        // placeholder below. Any endpoint that actually requires a valid
        // token (AccessTokenGuard) rejects this request with 401 on its
        // own, independent of whatever this middleware ends up binding.
      }
    }

    const tenantId = req.headers['x-tenant-id'];
    if (!tenantId || Array.isArray(tenantId)) {
      next();
      return;
    }

    const actorIdHeader = req.headers['x-actor-id'];
    const actorId = Array.isArray(actorIdHeader) ? actorIdHeader[0] : actorIdHeader;
    const actorTypeHeader = req.headers['x-actor-type'];
    const actorTypeValue = Array.isArray(actorTypeHeader) ? actorTypeHeader[0] : actorTypeHeader;
    const actorType =
      actorTypeValue && VALID_ACTOR_TYPES.has(actorTypeValue) ? (actorTypeValue as ActorType) : undefined;
    // ADR-0014 (unchanged): only reached when no valid Bearer token was
    // presented - ADR-0049 does not harden this fallback path itself.
    const isPlatformAdmin = req.headers['x-platform-admin'] === 'true';

    this.tenantContext.run({ tenantId, actorId, actorType, isPlatformAdmin }, () => next());
  }
}
