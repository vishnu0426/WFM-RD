import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { TenantTokenMatchGuard } from '../../../src/auth/tenant-token-match.guard';
import { TenantContextService } from '../../../src/common/tenant/tenant-context.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { RequestWithTokenClaims } from '../../../src/auth/access-token.guard';

function fakeGraphQLContext(request: RequestWithTokenClaims): ExecutionContext {
  return {
    getType: () => 'graphql',
    getArgs: () => [{}, {}, { req: request }, {}],
    getClass: () => class {},
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

describe('TenantTokenMatchGuard', () => {
  let metrics: MetricsService;
  let tenantContext: TenantContextService;

  beforeEach(() => {
    metrics = new MetricsService();
    metrics.onModuleInit();
    tenantContext = new TenantContextService();
  });

  function buildGuard(): TenantTokenMatchGuard {
    return new TenantTokenMatchGuard(tenantContext, metrics);
  }

  it('allows the request through when the token tenant matches the request tenant context', () => {
    tenantContext.run({ tenantId: '11111111-1111-1111-1111-111111111111' }, () => {
      const guard = buildGuard();
      const request = {
        headers: {},
        tokenClaims: { tenant_id: '11111111-1111-1111-1111-111111111111', permissions: [] },
      } as unknown as RequestWithTokenClaims;

      expect(guard.canActivate(fakeGraphQLContext(request))).toBe(true);
    });
  });

  it('throws ForbiddenException and records a metric when a valid token for tenant A is used against a spoofed x-tenant-id header for tenant B', () => {
    const spy = jest.spyOn(metrics, 'recordRbacDenial');
    tenantContext.run({ tenantId: '22222222-2222-2222-2222-222222222222' }, () => {
      const guard = buildGuard();
      const request = {
        headers: {},
        tokenClaims: { tenant_id: '11111111-1111-1111-1111-111111111111', permissions: ['ai_provider_config:write'] },
      } as unknown as RequestWithTokenClaims;

      expect(() => guard.canActivate(fakeGraphQLContext(request))).toThrow(ForbiddenException);
      expect(spy).toHaveBeenCalledWith('forbidden_tenant_mismatch');
    });
  });

  it('throws ForbiddenException when no token claims are present at all (AccessTokenGuard never ran or set nothing)', () => {
    tenantContext.run({ tenantId: '11111111-1111-1111-1111-111111111111' }, () => {
      const guard = buildGuard();
      const request = { headers: {} } as unknown as RequestWithTokenClaims;

      expect(() => guard.canActivate(fakeGraphQLContext(request))).toThrow(ForbiddenException);
    });
  });
});
