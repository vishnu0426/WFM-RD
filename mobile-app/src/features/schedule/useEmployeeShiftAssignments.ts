import { useQuery } from '@tanstack/react-query';

import { getEmployeeShiftAssignments } from '@/api/scheduling';
import { useCurrentIdentity } from '@/identity/useCurrentIdentity';

/** Bounded fetch/cache window — avoids an unbounded request as more of an
 * employee's schedule gets published over time. */
const WINDOW_DAYS_AHEAD = 14;

export function useEmployeeShiftAssignments() {
  const identity = useCurrentIdentity();

  const now = new Date();
  const from = now;
  const to = new Date(now.getTime() + WINDOW_DAYS_AHEAD * 24 * 60 * 60 * 1000);
  const windowKey = from.toDateString();

  return useQuery({
    queryKey: ['employeeShiftAssignments', identity.tenantId, identity.employeeId, windowKey],
    queryFn: ({ signal }) =>
      getEmployeeShiftAssignments({
        employeeId: identity.employeeId,
        tenantId: identity.tenantId,
        apiBaseUrl: identity.apiBaseUrl,
        from,
        to,
        signal,
      }),
  });
}
