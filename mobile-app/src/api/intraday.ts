import { graphqlRequest } from './client';
import { AgentLiveState } from './types';

const AGENT_LIVE_STATE_QUERY = `
  query AgentLiveState($employeeId: ID!) {
    agentLiveState(employeeId: $employeeId) {
      employeeId
      currentActivity
      activityStartedAt
      scheduledActivity
      adherenceStatus
      siteId
      queueId
      dataFreshness { status lastKnownUpdateAt }
    }
  }
`;

/**
 * intraday-service's real-time "what is this employee doing right now"
 * snapshot (docs/adr/0156) — already existed before Phase 7, this is its
 * first real caller. `null` on the field itself (not the whole response)
 * means no live/fallback data was found for this employee at all.
 */
export async function getAgentLiveState(params: {
  employeeId: string;
  tenantId: string;
  apiBaseUrl: string;
}): Promise<AgentLiveState | null> {
  const data = await graphqlRequest<{ agentLiveState: AgentLiveState | null }>(
    params.apiBaseUrl,
    AGENT_LIVE_STATE_QUERY,
    { employeeId: params.employeeId },
    params.tenantId,
  );
  return data.agentLiveState;
}
