import { AttendanceExceptionController } from '../../../src/attendance/attendance-exception.controller';
import { AttendanceExceptionType } from '../../../src/attendance/entities/attendance-record.entity';
import { ListAttendanceExceptionsQueryDto } from '../../../src/attendance/dto/list-attendance-exceptions-query.dto';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ORG_UNIT_ID = '22222222-2222-4222-8222-222222222222';

function buildController() {
  const listService = { listForOrgUnit: jest.fn().mockResolvedValue([]) };
  const tenantContext = { requireTenantId: jest.fn().mockReturnValue(TENANT_ID) };
  const controller = new AttendanceExceptionController(listService as never, tenantContext as never);
  return { controller, listService };
}

describe('AttendanceExceptionController.listExceptions (Attendance & Leave Manager Views phase)', () => {
  it('parses the date range and passes the org unit, filter, and pagination through', async () => {
    const { controller, listService } = buildController();
    const query = Object.assign(new ListAttendanceExceptionsQueryDto(), {
      orgUnitId: ORG_UNIT_ID,
      dateFrom: '2026-08-01T00:00:00.000Z',
      dateTo: '2026-08-15T00:00:00.000Z',
    });

    await controller.listExceptions(query);

    expect(listService.listForOrgUnit).toHaveBeenCalledWith(
      TENANT_ID,
      ORG_UNIT_ID,
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-08-15T00:00:00.000Z'),
      undefined,
      50,
      0,
    );
  });

  it('passes an explicit exceptionType/limit/offset through unchanged', async () => {
    const { controller, listService } = buildController();
    const query = Object.assign(new ListAttendanceExceptionsQueryDto(), {
      orgUnitId: ORG_UNIT_ID,
      dateFrom: '2026-08-01T00:00:00.000Z',
      dateTo: '2026-08-15T00:00:00.000Z',
      exceptionType: AttendanceExceptionType.LATE,
      limit: 10,
      offset: 20,
    });

    await controller.listExceptions(query);

    expect(listService.listForOrgUnit).toHaveBeenCalledWith(
      TENANT_ID,
      ORG_UNIT_ID,
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-08-15T00:00:00.000Z'),
      AttendanceExceptionType.LATE,
      10,
      20,
    );
  });
});
