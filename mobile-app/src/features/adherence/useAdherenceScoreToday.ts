import { useQuery } from '@tanstack/react-query';

import { getAdherenceScoreToday } from '@/api/adherenceCompliance';
import { getAdherenceComplianceApiBaseUrl } from '@/api/adherenceComplianceConfig';
import { useCurrentIdentity } from '@/identity/useCurrentIdentity';

export function useAdherenceScoreToday() {
  const identity = useCurrentIdentity();

  return useQuery({
    queryKey: ['adherenceScoreToday', identity.tenantId, identity.employeeId],
    queryFn: () =>
      getAdherenceScoreToday({
        employeeId: identity.employeeId,
        tenantId: identity.tenantId,
        apiBaseUrl: getAdherenceComplianceApiBaseUrl(),
      }),
  });
}
