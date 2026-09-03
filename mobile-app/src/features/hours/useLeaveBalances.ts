import { useQuery } from '@tanstack/react-query';

import { getEmployeeLeaveBalances } from '@/api/attendanceLeave';
import { getAttendanceLeaveApiBaseUrl } from '@/api/attendanceLeaveConfig';
import { useCurrentIdentity } from '@/identity/useCurrentIdentity';

export function useLeaveBalances() {
  const identity = useCurrentIdentity();

  return useQuery({
    queryKey: ['employeeLeaveBalances', identity.tenantId, identity.employeeId],
    queryFn: () =>
      getEmployeeLeaveBalances({
        employeeId: identity.employeeId,
        tenantId: identity.tenantId,
        apiBaseUrl: getAttendanceLeaveApiBaseUrl(),
      }),
  });
}
