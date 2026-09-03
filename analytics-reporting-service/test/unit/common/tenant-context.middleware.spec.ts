import 'reflect-metadata';
import { TenantContextMiddleware } from '../../../src/common/tenant/tenant-context.middleware';
import { TenantContextService } from '../../../src/common/tenant/tenant-context.service';

describe('TenantContextMiddleware', () => {
  let tenantContext: TenantContextService;
  let middleware: TenantContextMiddleware;

  beforeEach(() => {
    tenantContext = new TenantContextService();
    middleware = new TenantContextMiddleware(tenantContext);
  });

  function req(headers: Record<string, string>) {
    return { headers } as any;
  }

  it('binds tenantId (lowercased) and actorId (lowercased) when both headers are present', () => {
    middleware.use(
      req({
        'x-tenant-id': '11111111-1111-1111-1111-111111111111',
        'x-actor-id': 'AAAAAAAA-2222-2222-2222-222222222222',
      }),
      {} as any,
      () => {
        expect(tenantContext.requireTenantId()).toBe('11111111-1111-1111-1111-111111111111');
        expect(tenantContext.requireActorId()).toBe('aaaaaaaa-2222-2222-2222-222222222222');
      },
    );
  });

  it('binds tenant context with no actor when X-Actor-Id is absent', () => {
    middleware.use(req({ 'x-tenant-id': '11111111-1111-1111-1111-111111111111' }), {} as any, () => {
      expect(tenantContext.requireTenantId()).toBe('11111111-1111-1111-1111-111111111111');
      expect(() => tenantContext.requireActorId()).toThrow();
    });
  });

  it('does not bind any context when X-Tenant-Id is absent - next() still called', () => {
    const next = jest.fn();
    middleware.use(req({}), {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(() => tenantContext.requireTenantId()).toThrow();
  });
});
