import { ForbiddenException, UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { PermissionsGuard } from '../../src/modules/auth/rest/permissions.guard';

describe('PermissionsGuard', () => {
  const makeContext = (permissions: string[] | undefined, required: string[] | undefined) => {
    const request = permissions === undefined ? {} : { tokenClaims: { permissions } };
    const reflector = { get: jest.fn().mockReturnValue(required) };
    const context = {
      getHandler: jest.fn(),
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, reflector };
  };

  it('allows the request when no @RequirePermissions metadata is present', () => {
    const { context, reflector } = makeContext(undefined, undefined);
    const guard = new PermissionsGuard(reflector as never);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows the request when the caller holds every required permission', () => {
    const { context, reflector } = makeContext(['policy:read', 'policy:write'], ['policy:write']);
    const guard = new PermissionsGuard(reflector as never);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('throws ForbiddenException when a required permission is missing', () => {
    const { context, reflector } = makeContext(['policy:read'], ['policy:write']);
    const guard = new PermissionsGuard(reflector as never);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('throws UnauthorizedException when no tokenClaims are bound (AccessTokenGuard did not run first)', () => {
    const { context, reflector } = makeContext(undefined, ['policy:write']);
    const guard = new PermissionsGuard(reflector as never);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('requires ALL listed permissions, not just one', () => {
    const { context, reflector } = makeContext(['policy:write'], ['policy:write', 'policy:approve']);
    const guard = new PermissionsGuard(reflector as never);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
