import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../../../src/auth/permissions.guard';
import { RequestWithTokenClaims } from '../../../src/auth/access-token.guard';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

function fakeGraphQLContext(request: RequestWithTokenClaims): ExecutionContext {
  return {
    getType: () => 'graphql',
    getArgs: () => [{}, {}, { req: request }, {}],
    getClass: () => class {},
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
    metrics.onModuleInit();
  });

  function buildGuard(required: string[] | undefined): PermissionsGuard {
    const reflector = { get: () => required } as unknown as Reflector;
    return new PermissionsGuard(reflector, metrics);
  }

  it('allows the request through when the handler has no @RequirePermissions at all', () => {
    const guard = buildGuard(undefined);
    const request = { headers: {} } as unknown as RequestWithTokenClaims;

    expect(guard.canActivate(fakeGraphQLContext(request))).toBe(true);
  });

  it('throws UnauthorizedException when AccessTokenGuard never ran (no tokenClaims present)', () => {
    const guard = buildGuard(['ai_provider_config:write']);
    const request = { headers: {} } as unknown as RequestWithTokenClaims;

    expect(() => guard.canActivate(fakeGraphQLContext(request))).toThrow(UnauthorizedException);
  });

  it('throws ForbiddenException when the token lacks the required permission, and records an RBAC-denial metric (docs/adr/0133)', () => {
    const spy = jest.spyOn(metrics, 'recordRbacDenial');
    const guard = buildGuard(['ai_provider_config:write']);
    const request = {
      headers: {},
      tokenClaims: { tenant_id: 't1', permissions: ['schedule:read'] },
    } as unknown as RequestWithTokenClaims;

    expect(() => guard.canActivate(fakeGraphQLContext(request))).toThrow(ForbiddenException);
    expect(spy).toHaveBeenCalledWith('forbidden_permission');
  });

  it('allows the request through when the token holds the required permission', () => {
    const guard = buildGuard(['ai_provider_config:write']);
    const request = {
      headers: {},
      tokenClaims: { tenant_id: 't1', permissions: ['ai_provider_config:write', 'schedule:read'] },
    } as unknown as RequestWithTokenClaims;

    expect(guard.canActivate(fakeGraphQLContext(request))).toBe(true);
  });

  it('AND-combines multiple required permissions - missing even one is rejected', () => {
    const guard = buildGuard(['ai_provider_config:write', 'ai_governance_policy:write']);
    const request = {
      headers: {},
      tokenClaims: { tenant_id: 't1', permissions: ['ai_provider_config:write'] },
    } as unknown as RequestWithTokenClaims;

    expect(() => guard.canActivate(fakeGraphQLContext(request))).toThrow(/ai_governance_policy:write/);
  });
});
