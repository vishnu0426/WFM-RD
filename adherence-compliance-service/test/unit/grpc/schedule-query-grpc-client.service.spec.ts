import { of, throwError } from 'rxjs';
import { ClientGrpc } from '@nestjs/microservices';
import { ScheduleQueryGrpcClientService } from '../../../src/grpc/schedule-query-grpc-client.service';

describe('ScheduleQueryGrpcClientService', () => {
  let listPublishedShiftAssignments: jest.Mock;
  let grpcClient: jest.Mocked<Pick<ClientGrpc, 'getService'>>;
  let service: ScheduleQueryGrpcClientService;

  const windowStart = new Date('2026-06-01T00:00:00Z');
  const windowEnd = new Date('2026-06-08T00:00:00Z');

  beforeEach(() => {
    listPublishedShiftAssignments = jest.fn();
    grpcClient = { getService: jest.fn().mockReturnValue({ listPublishedShiftAssignments }) };
    service = new ScheduleQueryGrpcClientService(grpcClient as unknown as ClientGrpc);
    service.onModuleInit();
  });

  it("resolves the ScheduleQueryService client from the ClientGrpc proxy by the proto's service name", () => {
    expect(grpcClient.getService).toHaveBeenCalledWith('ScheduleQueryService');
  });

  it('returns [] without calling the client when employeeIds is empty', async () => {
    const result = await service.listPublishedShiftAssignments('tenant-1', [], windowStart, windowEnd);
    expect(result).toEqual([]);
    expect(listPublishedShiftAssignments).not.toHaveBeenCalled();
  });

  it('collects every streamed record into one array, passing an ISO window', async () => {
    const record1 = {
      employeeId: 'emp-1',
      scheduleId: 'sched-1',
      shiftStart: '2026-06-02T09:00:00Z',
      shiftEnd: '2026-06-02T17:00:00Z',
      isOvertime: false,
    };
    const record2 = {
      employeeId: 'emp-2',
      scheduleId: 'sched-1',
      shiftStart: '2026-06-02T09:00:00Z',
      shiftEnd: '2026-06-02T17:00:00Z',
      isOvertime: true,
    };
    listPublishedShiftAssignments.mockReturnValue(of(record1, record2));

    const result = await service.listPublishedShiftAssignments('tenant-1', ['emp-1', 'emp-2'], windowStart, windowEnd);

    expect(result).toEqual([record1, record2]);
    expect(listPublishedShiftAssignments).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      employeeIds: ['emp-1', 'emp-2'],
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    });
  });

  it('wraps a transport failure in ScheduleQueryGrpcClientUnavailableError', async () => {
    listPublishedShiftAssignments.mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
    await expect(service.listPublishedShiftAssignments('tenant-1', ['emp-1'], windowStart, windowEnd)).rejects.toThrow(
      'ScheduleQueryService.ListPublishedShiftAssignments unavailable',
    );
  });
});
