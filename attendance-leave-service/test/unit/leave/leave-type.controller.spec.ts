import { LeaveTypeController } from '../../../src/leave/leave-type.controller';
import { CreateLeaveTypeDto } from '../../../src/leave/dto/create-leave-type.dto';
import { UpdateLeaveTypeDto } from '../../../src/leave/dto/update-leave-type.dto';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const LEAVE_TYPE_ID = '33333333-3333-4333-8333-333333333333';

function buildController() {
  const leaveTypeService = {
    findAll: jest.fn().mockResolvedValue([]),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const tenantContext = { requireTenantId: jest.fn().mockReturnValue(TENANT_ID) };
  const controller = new LeaveTypeController(leaveTypeService as never, tenantContext as never);
  return { controller, leaveTypeService, tenantContext };
}

describe('LeaveTypeController', () => {
  it('findAll passes the bound tenant through', async () => {
    const { controller, leaveTypeService } = buildController();

    await controller.findAll();

    expect(leaveTypeService.findAll).toHaveBeenCalledWith(TENANT_ID);
  });

  it('findOne passes tenant and id through', async () => {
    const { controller, leaveTypeService } = buildController();

    await controller.findOne(LEAVE_TYPE_ID);

    expect(leaveTypeService.findById).toHaveBeenCalledWith(TENANT_ID, LEAVE_TYPE_ID);
  });

  it('create passes tenant and dto through', async () => {
    const { controller, leaveTypeService } = buildController();
    const dto = Object.assign(new CreateLeaveTypeDto(), {
      name: 'Annual',
      accrualPolicyId: '44444444-4444-4444-8444-444444444444',
    });

    await controller.create(dto);

    expect(leaveTypeService.create).toHaveBeenCalledWith(TENANT_ID, dto);
  });

  it('update passes tenant, id, and dto through', async () => {
    const { controller, leaveTypeService } = buildController();
    const dto = Object.assign(new UpdateLeaveTypeDto(), { maxConsecutiveDays: 10 });

    await controller.update(LEAVE_TYPE_ID, dto);

    expect(leaveTypeService.update).toHaveBeenCalledWith(TENANT_ID, LEAVE_TYPE_ID, dto);
  });

  it('remove passes tenant and id through', async () => {
    const { controller, leaveTypeService } = buildController();

    await controller.remove(LEAVE_TYPE_ID);

    expect(leaveTypeService.delete).toHaveBeenCalledWith(TENANT_ID, LEAVE_TYPE_ID);
  });
});
