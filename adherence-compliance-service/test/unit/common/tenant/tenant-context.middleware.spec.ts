import { Request, Response } from 'express';
import { TenantContextMiddleware } from '../../../../src/common/tenant/tenant-context.middleware';
import { TenantContextService } from '../../../../src/common/tenant/tenant-context.service';

describe('TenantContextMiddleware', () => {
  let tenantContext: TenantContextService;
  let middleware: TenantContextMiddleware;

  beforeEach(() => {
    tenantContext = new TenantContextService();
    middleware = new TenantContextMiddleware(tenantContext);
  });

  function request(headerValue: string | string[] | undefined): Request {
    return { headers: { 'x-tenant-id': headerValue } } as unknown as Request;
  }

  /**
   * Real bug found in Phase 7's own E2E verification (docs/adr/0106): an
   * uppercase header (macOS `uuidgen`'s own default form) made every
   * plain-JS tenant-ownership comparison elsewhere in this service
   * silently reject a caller's own rows, since Postgres always returns a
   * `uuid` column's value in canonical lowercase. Fixed by normalizing
   * once, here.
   */
  it('lowercases an uppercase X-Tenant-Id header before binding context', () => {
    middleware.use(request('E80348B7-B9A0-4057-936D-B8D6554B91CC'), {} as Response, () => {
      expect(tenantContext.requireTenantId()).toBe('e80348b7-b9a0-4057-936d-b8d6554b91cc');
    });
  });

  it('leaves an already-lowercase header unchanged', () => {
    middleware.use(request('e80348b7-b9a0-4057-936d-b8d6554b91cc'), {} as Response, () => {
      expect(tenantContext.requireTenantId()).toBe('e80348b7-b9a0-4057-936d-b8d6554b91cc');
    });
  });

  it('does not bind context (and does not throw) for a missing header', () => {
    const next = jest.fn();
    middleware.use(request(undefined), {} as Response, next);
    expect(next).toHaveBeenCalled();
    expect(tenantContext.getStore()).toBeUndefined();
  });

  it('does not bind context for a malformed (non-array-safe) header value', () => {
    const next = jest.fn();
    middleware.use(request(['a', 'b']), {} as Response, next);
    expect(next).toHaveBeenCalled();
    expect(tenantContext.getStore()).toBeUndefined();
  });
});
