/* Real-Time Integration → Event Capabilities / Event Ingestion Status /
   Event Diagnostics. Real backend: relay start/stop/status REST
   (integration-hub-service's RelayController, ACD connectors only) +
   connectorsHealth GraphQL for status/diagnostics. No NATS infrastructure
   is exposed here — only the resulting business-level status, per the
   plan's architectural boundary. "Processing Lag" is explicitly marked
   BACKEND GAP — no such metric is computed anywhere in this platform
   today (confirmed by research), so it is not fabricated. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, stBadge, fmtDt, gap } from '../../identity-org/shared/ui.js';

const HEALTH_QUERY = `query { connectorsHealth { connectorId provider connectorType status lastSyncAt lastSyncStatus hasActiveStreamingSession recentSyncJobs { id status startedAt completedAt recordsProcessed recordsFailed errorDetails } } }`;

function loadHealth(state) {
  state.wf.connectorsHealth = { loading: true };
  Api.integrationHubGql(HEALTH_QUERY, {})
    .then((data) => { state.wf.connectorsHealth = { rows: data.connectorsHealth }; doRerender(); })
    .catch((err) => { state.wf.connectorsHealth = { error: errMsg(err) }; doRerender(); });
}

function acdRows(state) {
  const rows = (state.wf.connectorsHealth && state.wf.connectorsHealth.rows) || [];
  return rows.filter((h) => h.connectorType === 'ACD');
}

function loadingOrError(state) {
  const list = state.wf.connectorsHealth;
  if (!list) { loadHealth(state); return `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`; }
  if (list.loading) return `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  if (list.error) return `<p class="muted">${esc(list.error)}</p>`;
  return null;
}

function renderCapabilities(state) {
  const loading = loadingOrError(state);
  const rows = acdRows(state);
  const body = loading || (rows.length === 0
    ? empty('No ACD data sources yet.', 'Event capabilities apply to real-time ACD connectors only.')
    : `<table class="data"><thead><tr><th>Provider</th><th>Relay Status</th><th></th></tr></thead><tbody>
        ${rows.map((h) => `<tr>
          <td>${esc(h.provider)}</td>
          <td>${h.hasActiveStreamingSession ? '<span class="badge badge-ok">Active</span>' : '<span class="badge badge-off">Stopped</span>'}</td>
          <td class="row-actions">
            ${h.hasActiveStreamingSession
              ? `<button class="btn btn-sm btn-danger" data-wf="rt-relay-stop" data-id="${h.connectorId}">Stop</button>`
              : `<button class="btn btn-sm" data-wf="rt-relay-start" data-id="${h.connectorId}">Start</button>`}
          </td>
        </tr>`).join('')}
      </tbody></table>`);
  return `${pageHead('Event Capabilities', 'Real-time ACD relay sessions — start/stop the live event stream per data source.', `<button class="btn" data-wf="rt-refresh">Refresh</button>`)}
    ${sec('ACD Data Sources', body, `<span class="meta">REST: /v1/integrations/connectors/:id/relay/start|stop</span>`)}`;
}

function renderIngestionStatus(state) {
  const loading = loadingOrError(state);
  const rows = acdRows(state);
  const body = loading || (rows.length === 0
    ? empty('No ACD data sources yet.', '')
    : rows.map((h) => `<div class="panel" style="margin-bottom:12px"><div style="padding:16px">
        <h3 style="margin:0 0 10px">${esc(h.provider)}</h3>
        <table class="kv">
          <tr><th>Connection</th><td>${stBadge(h.status)}</td></tr>
          <tr><th>Event Ingestion</th><td>${h.hasActiveStreamingSession ? '<span class="badge badge-ok">Healthy</span>' : '<span class="badge badge-off">Not streaming</span>'}</td></tr>
          <tr><th>Last Event</th><td>${h.lastSyncAt ? fmtDt(h.lastSyncAt) : '—'}</td></tr>
          <tr><th>Processing Status</th><td>${h.recentSyncJobs[0] ? stBadge(h.recentSyncJobs[0].status) : '—'}</td></tr>
          <tr><th>Processing Lag</th><td>${gap('No lag metric is computed anywhere in this platform today.')}</td></tr>
          <tr><th>Last Error</th><td>${h.recentSyncJobs.find((j) => j.status === 'failed') ? esc(JSON.stringify(h.recentSyncJobs.find((j) => j.status === 'failed').errorDetails || {})) : 'None'}</td></tr>
        </table>
      </div></div>`).join(''));
  return `${pageHead('Event Ingestion Status', 'Business-level ingestion status — no NATS/JetStream infrastructure is exposed here.', `<button class="btn" data-wf="rt-refresh">Refresh</button>`)}
    ${sec('Data Sources', body)}`;
}

function renderDiagnostics(state) {
  const loading = loadingOrError(state);
  const rows = acdRows(state);
  const body = loading || (rows.length === 0
    ? empty('No ACD data sources yet.', '')
    : rows.map((h) => `<div class="panel" style="margin-bottom:12px"><div style="padding:16px">
        <h3 style="margin:0 0 10px">${esc(h.provider)}</h3>
        ${h.recentSyncJobs.length === 0 ? '<p class="muted">No recent sessions.</p>' : `<table class="data"><thead><tr><th>Status</th><th>Started</th><th>Completed</th><th>Events Forwarded</th><th>Failed</th><th>Error</th></tr></thead><tbody>
          ${h.recentSyncJobs.map((j) => `<tr>
            <td>${stBadge(j.status)}</td>
            <td>${fmtDt(j.startedAt)}</td>
            <td>${j.completedAt ? fmtDt(j.completedAt) : '—'}</td>
            <td>${j.recordsProcessed}</td>
            <td>${j.recordsFailed}</td>
            <td class="muted">${j.errorDetails ? esc(JSON.stringify(j.errorDetails)) : '—'}</td>
          </tr>`).join('')}
        </tbody></table>`}
      </div></div>`).join(''));
  return `${pageHead('Event Diagnostics', 'Recent relay session history per ACD data source.', `<button class="btn" data-wf="rt-refresh">Refresh</button>`)}
    ${sec('Data Sources', body)}`;
}

export function render(state) {
  if (state.tab === 'rt-capabilities') return renderCapabilities(state);
  if (state.tab === 'rt-ingestion') return renderIngestionStatus(state);
  return renderDiagnostics(state);
}

export function handle(state, act, id) {
  if (act === 'rt-refresh') { state.wf.connectorsHealth = null; return true; }
  if (act === 'rt-relay-start') {
    Api.integrationHubApi(`/v1/integrations/connectors/${id}/relay/start`, { method: 'POST' })
      .then(() => { toast('Relay started.'); state.wf.connectorsHealth = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === 'rt-relay-stop') {
    Api.integrationHubApi(`/v1/integrations/connectors/${id}/relay/stop`, { method: 'POST' })
      .then(() => { toast('Relay stopped.'); state.wf.connectorsHealth = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
