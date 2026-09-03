import { TimezoneResolverService } from '../../../src/adherence/timezone-resolver.service';
import { EmployeeGrpcClientService } from '../../../src/grpc/employee-grpc-client.service';
import { CalendarGrpcClientService } from '../../../src/grpc/calendar-grpc-client.service';

describe('TimezoneResolverService', () => {
  let service: TimezoneResolverService;
  let getEmployeeOrgUnits: jest.Mock;
  let getWorkingTimeRules: jest.Mock;

  beforeEach(() => {
    getEmployeeOrgUnits = jest.fn();
    getWorkingTimeRules = jest.fn();
    service = new TimezoneResolverService(
      { getEmployeeOrgUnits } as unknown as EmployeeGrpcClientService,
      { getWorkingTimeRules } as unknown as CalendarGrpcClientService,
    );
  });

  it('returns an empty map for an empty employee list without calling anything', async () => {
    const result = await service.resolveTimezones('t1', []);
    expect(result.size).toBe(0);
    expect(getEmployeeOrgUnits).not.toHaveBeenCalled();
  });

  it("resolves each employee to its org unit's timezone, deduplicating the calendar lookup across employees sharing an org unit", async () => {
    getEmployeeOrgUnits.mockResolvedValue([
      { employeeId: 'e1', orgUnitId: 'ou1' },
      { employeeId: 'e2', orgUnitId: 'ou1' },
      { employeeId: 'e3', orgUnitId: 'ou2' },
    ]);
    getWorkingTimeRules.mockImplementation(async ({ orgUnitId }: { orgUnitId: string }) => ({
      countryCode: 'US',
      timezone: orgUnitId === 'ou1' ? 'America/New_York' : 'Asia/Kolkata',
      holidayDates: [],
      standardBusinessHoursJson: '{}',
    }));

    const result = await service.resolveTimezones('t1', ['e1', 'e2', 'e3']);

    expect(result.get('e1')).toBe('America/New_York');
    expect(result.get('e2')).toBe('America/New_York');
    expect(result.get('e3')).toBe('Asia/Kolkata');
    // One calendar lookup per distinct org unit, not per employee.
    expect(getWorkingTimeRules).toHaveBeenCalledTimes(2);
  });

  it('caches an org unit timezone across calls, never re-issuing getWorkingTimeRules for the same (tenant, orgUnit) within the TTL', async () => {
    getEmployeeOrgUnits.mockResolvedValue([{ employeeId: 'e1', orgUnitId: 'ou1' }]);
    getWorkingTimeRules.mockResolvedValue({
      countryCode: 'US',
      timezone: 'Europe/London',
      holidayDates: [],
      standardBusinessHoursJson: '{}',
    });

    await service.resolveTimezones('t1', ['e1']);
    await service.resolveTimezones('t1', ['e1']);

    expect(getWorkingTimeRules).toHaveBeenCalledTimes(1);
    expect(getEmployeeOrgUnits).toHaveBeenCalledTimes(2); // never cached - org unit assignment is mutable, always resolved fresh
  });

  it('falls back to UTC per employee, without throwing, when GetEmployeeOrgUnits is unavailable', async () => {
    getEmployeeOrgUnits.mockRejectedValue(new Error('core unreachable'));

    const result = await service.resolveTimezones('t1', ['e1', 'e2']);

    expect(result.get('e1')).toBe('UTC');
    expect(result.get('e2')).toBe('UTC');
  });

  it('falls back to UTC for one org unit whose calendar lookup fails, without affecting employees in a different, healthy org unit', async () => {
    getEmployeeOrgUnits.mockResolvedValue([
      { employeeId: 'e1', orgUnitId: 'ou-broken' },
      { employeeId: 'e2', orgUnitId: 'ou-healthy' },
    ]);
    getWorkingTimeRules.mockImplementation(async ({ orgUnitId }: { orgUnitId: string }) => {
      if (orgUnitId === 'ou-broken') {
        throw new Error('calendar service down');
      }
      return { countryCode: 'GB', timezone: 'Europe/London', holidayDates: [], standardBusinessHoursJson: '{}' };
    });

    const result = await service.resolveTimezones('t1', ['e1', 'e2']);

    expect(result.get('e1')).toBe('UTC');
    expect(result.get('e2')).toBe('Europe/London');
  });

  it('leaves an employee id absent from GetEmployeeOrgUnits results mapped to UTC, not omitted from the returned map', async () => {
    getEmployeeOrgUnits.mockResolvedValue([{ employeeId: 'e1', orgUnitId: 'ou1' }]); // e2 absent - sparse response
    getWorkingTimeRules.mockResolvedValue({
      countryCode: 'US',
      timezone: 'America/New_York',
      holidayDates: [],
      standardBusinessHoursJson: '{}',
    });

    const result = await service.resolveTimezones('t1', ['e1', 'e2']);

    expect(result.get('e1')).toBe('America/New_York');
    expect(result.get('e2')).toBe('UTC');
  });
});
