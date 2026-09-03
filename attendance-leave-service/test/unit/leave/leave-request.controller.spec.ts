import { LeaveRequestController } from '../../../src/leave/leave-request.controller';
import { LeaveRequestStatus } from '../../../src/leave/entities/leave-request.entity';
import { ListLeaveRequestsQueryDto } from '../../../src/leave/dto/list-leave-requests-query.dto';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ORG_UNIT_ID = '22222222-2222-4222-8222-222222222222';

function buildController() {
  const leaveRequestService = { requestLeave: jest.fn(), submitBackdatedLeave: jest.fn() };
  const listRequestsService = { listForOrgUnit: jest.fn().mockResolvedValue([]) };
  const tenantContext = { requireTenantId: jest.fn().mockReturnValue(TENANT_ID) };
  const controller = new LeaveRequestController(
    leaveRequestService as never,
    listRequestsService as never,
    tenantContext as never,
  );
  return { controller, listRequestsService, tenantContext };
}

describe('LeaveRequestController.listRequests (Attendance & Leave Manager Views phase)', () => {
  it('defaults status to pending and passes the org unit, limit, and offset through', async () => {
    const { controller, listRequestsService } = buildController();
    const query = Object.assign(new ListLeaveRequestsQueryDto(), { orgUnitId: ORG_UNIT_ID });

    await controller.listRequests(query);

    expect(listRequestsService.listForOrgUnit).toHaveBeenCalledWith(
      TENANT_ID,
      ORG_UNIT_ID,
      LeaveRequestStatus.PENDING,
      50,
      0,
    );
  });

  it('passes an explicit status/limit/offset through unchanged', async () => {
    const { controller, listRequestsService } = buildController();
    const query = Object.assign(new ListLeaveRequestsQueryDto(), {
      orgUnitId: ORG_UNIT_ID,
      status: LeaveRequestStatus.APPROVED,
      limit: 25,
      offset: 25,
    });

    await controller.listRequests(query);

    expect(listRequestsService.listForOrgUnit).toHaveBeenCalledWith(
      TENANT_ID,
      ORG_UNIT_ID,
      LeaveRequestStatus.APPROVED,
      25,
      25,
    );
  });
});
