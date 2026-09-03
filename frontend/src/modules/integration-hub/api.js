/* Integration Hub (Module 12, :8900) client. Real GraphQL wiring for the
   one query this app currently needs — the ACD connector list that backs
   the Employee "Workforce / Agent" tab's Data Source picker. The service
   verifies the same Bearer token the root-service login issues (its
   AccessTokenGuard fetches root's JWKS remotely), so no separate login is
   needed — see Api.gqlFetchAt. */
import { Api, WFM_CONFIG } from '../../core/api.js';

const BASE_URL = WFM_CONFIG.integrationHubBaseUrl || 'http://localhost:8900';

export async function healthCheck() {
  const res = await fetch(`${BASE_URL}/healthz`);
  if (!res.ok) throw new Error(`integration-hub health check failed (${res.status})`);
  return res.json().catch(() => ({ status: 'ok' }));
}

/** `connectors { id connectorType provider status lastSyncAt lastSyncStatus }` — gated by integration_connector:read (IntegrationConnectorResolver). */
export async function listConnectors() {
  const data = await Api.gqlFetchAt(BASE_URL, `query { connectors { id connectorType provider status lastSyncAt lastSyncStatus } }`);
  return data.connectors;
}

/** Just the ACD-type connectors — the only connectorType relevant to an employee's Data Source / Agent ID / Extension identity. */
export async function listAcdConnectors() {
  return (await listConnectors()).filter((c) => c.connectorType === 'ACD');
}
