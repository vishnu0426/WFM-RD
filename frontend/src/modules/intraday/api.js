/* Intraday / Real-Time (Module 05, :8200) client. Real REST + GraphQL
   wiring for intraday-service — queue live state (REST), agent live state
   (GraphQL only — no REST equivalent exists), and Adherence Exceptions
   (REST) — the Calendar console's Coverage/Adherence view modes. */
import { Api, WFM_CONFIG } from '../../core/api.js';

export async function healthCheck() {
  return Api.intradayApi('/healthz');
}

/* ---------- Queue live state ("Coverage") ---------- */
export const getQueueLive = (queueId) => Api.intradayApi(`/v1/intraday/queues/${queueId}/live`);

/* ---------- Agent live state ("Adherence") ----------
   GraphQL-only (no REST equivalent — see live-state-rest.controller.ts,
   which only exposes the queue-scoped one). One aliased query batches every
   employee id into a single round trip rather than N requests. Returns
   `null` per employee with no live data (nullable field), not an error. */
export async function getAgentLiveStates(employeeIds) {
  if (!employeeIds.length) return {};
  const query = `query(${employeeIds.map((_, i) => `$e${i}: ID!`).join(', ')}) {
    ${employeeIds.map((_, i) => `e${i}: agentLiveState(employeeId: $e${i}) { employeeId currentActivity activityStartedAt scheduledActivity adherenceStatus siteId queueId dataFreshness { status lastKnownUpdateAt } }`).join('\n')}
  }`;
  const variables = Object.fromEntries(employeeIds.map((id, i) => [`e${i}`, id]));
  const data = await Api.gqlFetchAt(WFM_CONFIG.intradayBaseUrl, query, variables);
  return employeeIds.map((id, i) => data[`e${i}`]);
}

/* ---------- Adherence Exceptions ---------- */
export const listAdherenceExceptions = (filters = {}) => {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.employeeId) params.set('employeeId', filters.employeeId);
  const qs = params.toString();
  return Api.intradayApi(`/v1/intraday/adherence-exceptions${qs ? `?${qs}` : ''}`);
};
export const acknowledgeAdherenceException = (id) => Api.intradayApi(`/v1/intraday/adherence-exceptions/${id}/acknowledge`, { method: 'POST' });
export const resolveAdherenceException = (id, resolutionNotes) =>
  Api.intradayApi(`/v1/intraday/adherence-exceptions/${id}/resolve`, { method: 'POST', body: { resolutionNotes } });
