import { ExecutionContext, HttpException } from '@nestjs/common';
import { AiInteractionRateLimitGuard } from '../../../src/auth/ai-interaction-rate-limit.guard';
import { AiInteractionRateLimiterService } from '../../../src/auth/ai-interaction-rate-limiter.service';
import { TenantContextService } from '../../../src/common/tenant/tenant-context.service';
import { RequestWithTokenClaims } from '../../../src/auth/access-token.guard';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

function fakeGraphQLContext(request: RequestWithTokenClaims): ExecutionContext {
  return {
    getType: () => 'graphql',
    getArgs: () => [{}, {}, { req: request }, {}],
    getClass: () => class {},
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

describe('AiInteractionRateLimitGuard (ADR-0162)', () => {
  let tenantContext: TenantContextService;
  let rateLimiter: { tryAcquire: jest.Mock };
  let guard: AiInteractionRateLimitGuard;

  beforeEach(() => {
    tenantContext = new TenantContextService();
    rateLimiter = { tryAcquire: jest.fn() };
    guard = new AiInteractionRateLimitGuard(rateLimiter as unknown as AiInteractionRateLimiterService, tenantContext);
  });

  it('allows the request through and passes (tenantId, actorId) to the limiter', () => {
    rateLimiter.tryAcquire.mockReturnValue({ allowed: true });
    const request: RequestWithTokenClaims = {
      headers: {},
      tokenClaims: { tenant_id: TENANT_A, permissions: [], sub: 'user-42' },
    } as unknown as RequestWithTokenClaims;

    tenantContext.run({ tenantId: TENANT_A }, () => {
      expect(guard.canActivate(fakeGraphQLContext(request))).toBe(true);
    });
    expect(rateLimiter.tryAcquire).toHaveBeenCalledWith(TENANT_A, 'user-42');
  });

  it('falls back to actorId "unknown" when the token carries no sub claim', () => {
    rateLimiter.tryAcquire.mockReturnValue({ allowed: true });
    const request: RequestWithTokenClaims = {
      headers: {},
      tokenClaims: { tenant_id: TENANT_A, permissions: [] },
    } as unknown as RequestWithTokenClaims;

    tenantContext.run({ tenantId: TENANT_A }, () => {
      guard.canActivate(fakeGraphQLContext(request));
    });
    expect(rateLimiter.tryAcquire).toHaveBeenCalledWith(TENANT_A, 'unknown');
  });

  it('throws a 429 HttpException with a retryAfterSeconds hint when the limiter denies', () => {
    rateLimiter.tryAcquire.mockReturnValue({ allowed: false, retryAfterSeconds: 12 });
    const request: RequestWithTokenClaims = {
      headers: {},
      tokenClaims: { tenant_id: TENANT_A, permissions: [], sub: 'user-42' },
    } as unknown as RequestWithTokenClaims;

    tenantContext.run({ tenantId: TENANT_A }, () => {
      let thrown: HttpException | undefined;
      try {
        guard.canActivate(fakeGraphQLContext(request));
      } catch (err) {
        thrown = err as HttpException;
      }
      expect(thrown).toBeInstanceOf(HttpException);
      expect(thrown?.getStatus()).toBe(429);
      expect(thrown?.getResponse()).toMatchObject({ retryAfterSeconds: 12 });
    });
  });
});
