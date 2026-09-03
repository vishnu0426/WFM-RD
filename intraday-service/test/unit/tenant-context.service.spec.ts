import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import {
  ActorContextMissingError,
  InvalidTenantIdError,
  TenantContextMissingError,
} from '../../src/common/tenant/tenant-context.errors';

describe('TenantContextService', () => {
  const VALID_TENANT_ID = '11111111-1111-1111-1111-111111111111';

  it('requireTenantId returns the bound tenantId inside run()', () => {
    const service = new TenantContextService();
    service.run({ tenantId: VALID_TENANT_ID }, () => {
      expect(service.requireTenantId()).toBe(VALID_TENANT_ID);
    });
  });

  it('requireTenantId throws TenantContextMissingError outside of run()', () => {
    const service = new TenantContextService();
    expect(() => service.requireTenantId()).toThrow(TenantContextMissingError);
  });

  it('run() rejects a non-UUID tenantId', () => {
    const service = new TenantContextService();
    expect(() => service.run({ tenantId: 'not-a-uuid' }, () => undefined)).toThrow(InvalidTenantIdError);
  });

  it('getStore reflects the bound context', () => {
    const service = new TenantContextService();
    service.run({ tenantId: VALID_TENANT_ID }, () => {
      expect(service.getStore()).toEqual({ tenantId: VALID_TENANT_ID });
    });
    expect(service.getStore()).toBeUndefined();
  });

  it('requireActorId returns the bound actorId inside run()', () => {
    const service = new TenantContextService();
    service.run({ tenantId: VALID_TENANT_ID, actorId: 'actor-1' }, () => {
      expect(service.requireActorId()).toBe('actor-1');
    });
  });

  it('requireActorId throws ActorContextMissingError when no actorId was bound', () => {
    const service = new TenantContextService();
    service.run({ tenantId: VALID_TENANT_ID }, () => {
      expect(() => service.requireActorId()).toThrow(ActorContextMissingError);
    });
  });

  it('requireActorId throws ActorContextMissingError outside of run()', () => {
    const service = new TenantContextService();
    expect(() => service.requireActorId()).toThrow(ActorContextMissingError);
  });

  it('concurrent async contexts do not leak into each other', async () => {
    const service = new TenantContextService();
    const tenantA = '11111111-1111-1111-1111-111111111111';
    const tenantB = '22222222-2222-2222-2222-222222222222';

    const runA = service.run({ tenantId: tenantA }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return service.requireTenantId();
    });
    const runB = service.run({ tenantId: tenantB }, async () => {
      return service.requireTenantId();
    });

    const [resultA, resultB] = await Promise.all([runA, runB]);
    expect(resultA).toBe(tenantA);
    expect(resultB).toBe(tenantB);
  });
});
