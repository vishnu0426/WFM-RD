import { TenantContextMiddleware } from '../../src/common/http/tenant-context.middleware';

describe('TenantContextMiddleware', () => {
  const makeDeps = () => {
    const tenantContext = { run: jest.fn((_ctx: unknown, fn: () => unknown) => fn()) };
    const tokenService = { verifyAccessToken: jest.fn() };
    return { tenantContext, tokenService };
  };

  const makeReq = (headers: Record<string, string | undefined>) => ({ headers }) as never;
  const res = {} as never;

  it('binds tenant context from a valid Bearer token, ignoring any X-Tenant-Id header sent alongside it', async () => {
    const { tenantContext, tokenService } = makeDeps();
    tokenService.verifyAccessToken.mockResolvedValue({
      sub: 'user-1',
      tenant_id: 'tenant-a',
      roles: ['tenant_admin'],
      permissions: ['role:read'],
    });
    const middleware = new TenantContextMiddleware(tenantContext as never, tokenService as never);
    const next = jest.fn();

    // Attacker-style request: valid JWT for tenant-a, forged header for tenant-b.
    await middleware.use(
      makeReq({ authorization: 'Bearer valid-token', 'x-tenant-id': 'tenant-b', 'x-platform-admin': 'true' }),
      res,
      next,
    );

    expect(tenantContext.run).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', actorId: 'user-1', actorType: 'user', isPlatformAdmin: false },
      expect.any(Function),
    );
    expect(next).toHaveBeenCalled();
  });

  it('derives actorType=system for a client_credentials token (sub starting with client:)', async () => {
    const { tenantContext, tokenService } = makeDeps();
    tokenService.verifyAccessToken.mockResolvedValue({
      sub: 'client:oauth-client-1',
      tenant_id: 'tenant-a',
      roles: [],
      permissions: [],
    });
    const middleware = new TenantContextMiddleware(tenantContext as never, tokenService as never);
    const next = jest.fn();

    await middleware.use(makeReq({ authorization: 'Bearer valid-token' }), res, next);

    expect(tenantContext.run).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', actorId: 'client:oauth-client-1', actorType: 'system', isPlatformAdmin: false },
      expect.any(Function),
    );
  });

  it('sets isPlatformAdmin=true only from a real platform_admin role claim in the token, never from a header', async () => {
    const { tenantContext, tokenService } = makeDeps();
    tokenService.verifyAccessToken.mockResolvedValue({
      sub: 'user-1',
      tenant_id: 'tenant-a',
      roles: ['platform_admin'],
      permissions: [],
    });
    const middleware = new TenantContextMiddleware(tenantContext as never, tokenService as never);
    const next = jest.fn();

    await middleware.use(makeReq({ authorization: 'Bearer valid-token' }), res, next);

    expect(tenantContext.run).toHaveBeenCalledWith(
      expect.objectContaining({ isPlatformAdmin: true }),
      expect.any(Function),
    );
  });

  it('falls back to header-based binding (ADR-0014) when no Authorization header is present', async () => {
    const { tenantContext, tokenService } = makeDeps();
    const middleware = new TenantContextMiddleware(tenantContext as never, tokenService as never);
    const next = jest.fn();

    await middleware.use(makeReq({ 'x-tenant-id': 'tenant-b' }), res, next);

    expect(tokenService.verifyAccessToken).not.toHaveBeenCalled();
    expect(tenantContext.run).toHaveBeenCalledWith(
      { tenantId: 'tenant-b', actorId: undefined, actorType: undefined, isPlatformAdmin: false },
      expect.any(Function),
    );
  });

  it('falls back to header-based binding when the Bearer token fails verification', async () => {
    const { tenantContext, tokenService } = makeDeps();
    tokenService.verifyAccessToken.mockRejectedValue(new Error('invalid signature'));
    const middleware = new TenantContextMiddleware(tenantContext as never, tokenService as never);
    const next = jest.fn();

    await middleware.use(makeReq({ authorization: 'Bearer garbage', 'x-tenant-id': 'tenant-b' }), res, next);

    expect(tenantContext.run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-b' }),
      expect.any(Function),
    );
  });

  it('binds nothing and just calls next() when there is neither a valid Bearer token nor an X-Tenant-Id header', async () => {
    const { tenantContext, tokenService } = makeDeps();
    const middleware = new TenantContextMiddleware(tenantContext as never, tokenService as never);
    const next = jest.fn();

    await middleware.use(makeReq({}), res, next);

    expect(tenantContext.run).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
