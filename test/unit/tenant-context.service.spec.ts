import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { TenantContextMissingError, InvalidTenantIdError } from '../../src/common/tenant/tenant-context.errors';

describe('TenantContextService', () => {
  const validTenantId = '11111111-1111-4111-8111-111111111111';

  it('fails closed: requireTenantId throws when no context is bound', () => {
    const service = new TenantContextService();
    expect(() => service.requireTenantId()).toThrow(TenantContextMissingError);
  });

  it('returns the bound tenant id inside run()', () => {
    const service = new TenantContextService();
    const result = service.run({ tenantId: validTenantId }, () => service.requireTenantId());
    expect(result).toBe(validTenantId);
  });

  it('rejects a non-UUID tenant id rather than binding garbage', () => {
    const service = new TenantContextService();
    expect(() => service.run({ tenantId: 'not-a-uuid' }, () => undefined)).toThrow(InvalidTenantIdError);
  });

  it('does not leak context across independent run() calls', () => {
    const service = new TenantContextService();
    service.run({ tenantId: validTenantId }, () => undefined);
    expect(() => service.requireTenantId()).toThrow(TenantContextMissingError);
  });

  it('isolates concurrent async contexts from each other', async () => {
    const service = new TenantContextService();
    const otherTenantId = '22222222-2222-4222-8222-222222222222';

    const readAfterDelay = (tenantId: string, delayMs: number) =>
      service.run({ tenantId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return service.requireTenantId();
      });

    const [first, second] = await Promise.all([readAfterDelay(validTenantId, 20), readAfterDelay(otherTenantId, 5)]);

    expect(first).toBe(validTenantId);
    expect(second).toBe(otherTenantId);
  });
});
