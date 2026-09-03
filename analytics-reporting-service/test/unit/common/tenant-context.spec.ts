import 'reflect-metadata';
import { TenantContextService } from '../../../src/common/tenant/tenant-context.service';
import {
  ActorContextMissingError,
  InvalidTenantIdError,
  TenantContextMissingError,
} from '../../../src/common/tenant/tenant-context.errors';

describe('TenantContextService', () => {
  let service: TenantContextService;

  beforeEach(() => {
    service = new TenantContextService();
  });

  it('requireTenantId() returns the bound tenant inside run()', () => {
    service.run({ tenantId: '11111111-1111-1111-1111-111111111111' }, () => {
      expect(service.requireTenantId()).toBe('11111111-1111-1111-1111-111111111111');
    });
  });

  it('requireTenantId() throws TenantContextMissingError outside run()', () => {
    expect(() => service.requireTenantId()).toThrow(TenantContextMissingError);
  });

  it('run() rejects a structurally invalid tenant id', () => {
    expect(() => service.run({ tenantId: 'not-a-uuid' }, () => undefined)).toThrow(InvalidTenantIdError);
  });

  it('requireActorId() returns the bound actor when present (Phase 4)', () => {
    service.run(
      { tenantId: '11111111-1111-1111-1111-111111111111', actorId: '22222222-2222-2222-2222-222222222222' },
      () => {
        expect(service.requireActorId()).toBe('22222222-2222-2222-2222-222222222222');
      },
    );
  });

  it('requireActorId() throws ActorContextMissingError when tenant is bound but actor is not', () => {
    service.run({ tenantId: '11111111-1111-1111-1111-111111111111' }, () => {
      expect(() => service.requireActorId()).toThrow(ActorContextMissingError);
    });
  });
});
