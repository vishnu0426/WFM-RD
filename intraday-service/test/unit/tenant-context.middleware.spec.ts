import { TenantContextMiddleware } from '../../src/common/tenant/tenant-context.middleware';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';

describe('TenantContextMiddleware', () => {
  const VALID_TENANT_ID = '11111111-1111-1111-1111-111111111111';

  it('binds tenant context from a valid X-Tenant-Id header before calling next()', () => {
    const tenantContext = new TenantContextService();
    const middleware = new TenantContextMiddleware(tenantContext);
    const req = { headers: { 'x-tenant-id': VALID_TENANT_ID } } as never;
    let observedTenantId: string | undefined;
    const next = jest.fn(() => {
      observedTenantId = tenantContext.getStore()?.tenantId;
    });

    middleware.use(req, {} as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(observedTenantId).toBe(VALID_TENANT_ID);
  });

  it('calls next() without binding context when the header is missing (fail-closed-at-use, not at-the-gate)', () => {
    const tenantContext = new TenantContextService();
    const middleware = new TenantContextMiddleware(tenantContext);
    const req = { headers: {} } as never;
    const next = jest.fn();

    middleware.use(req, {} as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(tenantContext.getStore()).toBeUndefined();
  });

  it('does not bind context when the header is duplicated (array value)', () => {
    const tenantContext = new TenantContextService();
    const middleware = new TenantContextMiddleware(tenantContext);
    const req = { headers: { 'x-tenant-id': [VALID_TENANT_ID, VALID_TENANT_ID] } } as never;
    const next = jest.fn();

    middleware.use(req, {} as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(tenantContext.getStore()).toBeUndefined();
  });

  it('also binds actorId from a valid X-Actor-Id header', () => {
    const tenantContext = new TenantContextService();
    const middleware = new TenantContextMiddleware(tenantContext);
    const req = { headers: { 'x-tenant-id': VALID_TENANT_ID, 'x-actor-id': 'actor-1' } } as never;
    let observedStore: unknown;
    const next = jest.fn(() => {
      observedStore = tenantContext.getStore();
    });

    middleware.use(req, {} as never, next);

    expect(observedStore).toEqual({ tenantId: VALID_TENANT_ID, actorId: 'actor-1' });
  });

  it('binds tenant context with no actorId when X-Actor-Id is missing', () => {
    const tenantContext = new TenantContextService();
    const middleware = new TenantContextMiddleware(tenantContext);
    const req = { headers: { 'x-tenant-id': VALID_TENANT_ID } } as never;
    let observedStore: unknown;
    const next = jest.fn(() => {
      observedStore = tenantContext.getStore();
    });

    middleware.use(req, {} as never, next);

    expect(observedStore).toEqual({ tenantId: VALID_TENANT_ID, actorId: undefined });
  });

  it('does not bind actorId when the X-Actor-Id header is duplicated (array value)', () => {
    const tenantContext = new TenantContextService();
    const middleware = new TenantContextMiddleware(tenantContext);
    const req = { headers: { 'x-tenant-id': VALID_TENANT_ID, 'x-actor-id': ['a1', 'a2'] } } as never;
    let observedStore: unknown;
    const next = jest.fn(() => {
      observedStore = tenantContext.getStore();
    });

    middleware.use(req, {} as never, next);

    expect(observedStore).toEqual({ tenantId: VALID_TENANT_ID, actorId: undefined });
  });
});
