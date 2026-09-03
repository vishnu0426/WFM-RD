import { ReallocationRestController } from '../../src/reallocation/reallocation-rest.controller';

describe('ReallocationRestController.approve', () => {
  it('resolves the tenant from context and delegates to ReallocationApprovalService', async () => {
    const approved = { id: 'r1', tenantId: 't1', status: 'executed' };
    const reallocationApproval = { approve: jest.fn().mockResolvedValue(approved) };
    const tenantContext = { requireTenantId: jest.fn().mockReturnValue('t1') };
    const controller = new ReallocationRestController(reallocationApproval as never, tenantContext as never);

    const result = await controller.approve('r1');

    expect(reallocationApproval.approve).toHaveBeenCalledWith('t1', 'r1');
    expect(result).toBe(approved);
  });
});
