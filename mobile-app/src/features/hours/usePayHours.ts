import { useQuery } from '@tanstack/react-query';

import { getEmployeeAttendanceRecords } from '@/api/attendanceLeave';
import { getAttendanceLeaveApiBaseUrl } from '@/api/attendanceLeaveConfig';
import { useCurrentIdentity } from '@/identity/useCurrentIdentity';

/** No real pay-period concept exists anywhere in this platform
 * (docs/adr/0156) - a trailing 14-day window is a disclosed, arbitrary
 * placeholder, symmetric with `useEmployeeShiftAssignments.ts`'s own real
 * `WINDOW_DAYS_AHEAD = 14` forward-looking window, just backward instead
 * of forward. */
const WINDOW_DAYS_BACK = 14;

export function usePayHours() {
  const identity = useCurrentIdentity();

  const now = new Date();
  const from = new Date(now.getTime() - WINDOW_DAYS_BACK * 24 * 60 * 60 * 1000);
  const windowKey = now.toDateString();

  return useQuery({
    queryKey: ['employeeAttendanceRecords', identity.tenantId, identity.employeeId, windowKey],
    queryFn: () =>
      getEmployeeAttendanceRecords({
        employeeId: identity.employeeId,
        tenantId: identity.tenantId,
        apiBaseUrl: getAttendanceLeaveApiBaseUrl(),
        from,
        to: now,
      }),
  });
}
