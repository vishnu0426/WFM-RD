import { useQuery } from '@tanstack/react-query';

import { getAgentLiveState } from '@/api/intraday';
import { getIntradayApiBaseUrl } from '@/api/intradayConfig';
import { useCurrentIdentity } from '@/identity/useCurrentIdentity';

export function useAgentLiveState() {
  const identity = useCurrentIdentity();

  return useQuery({
    queryKey: ['agentLiveState', identity.tenantId, identity.employeeId],
    queryFn: () =>
      getAgentLiveState({
        employeeId: identity.employeeId,
        tenantId: identity.tenantId,
        apiBaseUrl: getIntradayApiBaseUrl(),
      }),
  });
}
