import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../../../src/auth/permissions.guard';
import { RequestWithTokenClaims } from '../../../src/auth/access-token.guard';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

function fakeHttpContext(request: RequestWithTokenClaims): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
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

    expect(guard.canActivate(fakeHttpContext(request))).toBe(true);
  });

  it('throws UnauthorizedException when AccessTokenGuard never ran (no tokenClaims present)', () => {
    const guard = buildGuard(['leave_request:read']);
    const request = { headers: {} } as unknown as RequestWithTokenClaims;

    expect(() => guard.canActivate(fakeHttpContext(request))).toThrow(UnauthorizedException);
  });

  it('throws ForbiddenException when the token lacks the required permission, and records an RBAC-denial metric', () => {
    const spy = jest.spyOn(metrics, 'recordRbacDenial');
    const guard = buildGuard(['attendance_record:read']);
    const request = {
      headers: {},
      tokenClaims: { tenant_id: 't1', permissions: ['leave_request:read'] },
    } as unknown as RequestWithTokenClaims;

    expect(() => guard.canActivate(fakeHttpContext(request))).toThrow(ForbiddenException);
    expect(spy).toHaveBeenCalledWith('forbidden_permission');
  });

  it('allows the request through when the token holds the required permission', () => {
    const guard = buildGuard(['leave_request:read']);
    const request = {
      headers: {},
      tokenClaims: { tenant_id: 't1', permissions: ['leave_request:read', 'attendance_record:read'] },
    } as unknown as RequestWithTokenClaims;

    expect(guard.canActivate(fakeHttpContext(request))).toBe(true);
  });
});
