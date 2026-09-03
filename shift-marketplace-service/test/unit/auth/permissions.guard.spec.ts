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
    const guard = buildGuard(['marketplace_claim:read']);
    const request = { headers: {} } as unknown as RequestWithTokenClaims;

    expect(() => guard.canActivate(fakeGraphQLContext(request))).toThrow(UnauthorizedException);
  });

  it('throws ForbiddenException when the token lacks the required permission, and records an RBAC-denial metric', () => {
    const spy = jest.spyOn(metrics, 'recordRbacDenial');
    const guard = buildGuard(['marketplace_claim:approve']);
    const request = {
      headers: {},
      tokenClaims: { tenant_id: 't1', permissions: ['marketplace_post:read'] },
    } as unknown as RequestWithTokenClaims;

    expect(() => guard.canActivate(fakeGraphQLContext(request))).toThrow(ForbiddenException);
    expect(spy).toHaveBeenCalledWith('forbidden_permission');
  });

  it('allows the request through when the token holds the required permission', () => {
    const guard = buildGuard(['marketplace_claim:read']);
    const request = {
      headers: {},
      tokenClaims: { tenant_id: 't1', permissions: ['marketplace_claim:read', 'marketplace_post:read'] },
    } as unknown as RequestWithTokenClaims;

    expect(guard.canActivate(fakeGraphQLContext(request))).toBe(true);
  });

  it('AND-combines multiple required permissions - missing even one is rejected', () => {
    const guard = buildGuard(['marketplace_claim:read', 'marketplace_post:read']);
    const request = {
      headers: {},
      tokenClaims: { tenant_id: 't1', permissions: ['marketplace_claim:read'] },
    } as unknown as RequestWithTokenClaims;

    expect(() => guard.canActivate(fakeGraphQLContext(request))).toThrow(/marketplace_post:read/);
  });
});
