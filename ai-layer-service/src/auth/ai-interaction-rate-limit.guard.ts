import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { RequestWithTokenClaims } from './access-token.guard';
import { AiInteractionRateLimiterService } from './ai-interaction-rate-limiter.service';
import { TenantContextService } from '../common/tenant/tenant-context.service';

/**
 * ADR-0162: fourth guard, added after `TenantTokenMatchGuard` in every
 * `AIInteraction`-generating resolver's `@UseGuards(...)` list - runs last
 * so it only ever spends a token on a request that already passed
 * authentication/authorization, not on a caller who was going to be
 * rejected anyway. Scoped per `(tenantId, actorId)` - `actorId` read
 * directly from `request.tokenClaims.sub` (the same claim `@CurrentTokenClaims()`
 * exposes to the resolver itself), not passed as a parameter, since a
 * Guard runs before resolver-argument binding.
 */
@Injectable()
export class AiInteractionRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimiter: AiInteractionRateLimiterService,
    private readonly tenantContext: TenantContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = this.getRequest(context);
    const tenantId = this.tenantContext.requireTenantId();
    const actorId = request.tokenClaims?.sub ?? 'unknown';

    const decision = this.rateLimiter.tryAcquire(tenantId, actorId);
    if (!decision.allowed) {
      throw new HttpException(
        {
          message: 'Too many AI interaction requests for this tenant. Try again later.',
          retryAfterSeconds: decision.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private getRequest(context: ExecutionContext): RequestWithTokenClaims {
    if (context.getType<GqlContextType>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext<{ req: RequestWithTokenClaims }>().req;
    }
    return context.switchToHttp().getRequest<RequestWithTokenClaims>();
  }
}
