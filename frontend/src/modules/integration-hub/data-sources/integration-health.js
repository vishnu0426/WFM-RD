/* Data Sources → Integration Health. Real backend: integration-hub-service's
   connectorsHealth GraphQL — a real aggregate over IntegrationConnector +
   SyncJob history + streaming-relay status (not a fabricated score). */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { pageHead, sec, empty, stBadge, fmtDt } from '../../identity-org/shared/ui.js';

const HEALTH_QUERY = `query { connectorsHealth { connectorId provider connectorType status lastSyncAt lastSyncStatus hasActiveStreamingSession recentSyncJobs { id status startedAt completedAt recordsFailed errorDetails } } }`;

function loadHealth(state) {
  state.wf.connectorsHealth = { loading: true };
  Api.integrationHubGql(HEALTH_QUERY, {})
    .then((data) => { state.wf.connectorsHealth = { rows: data.connectorsHealth }; doRerender(); })
    .catch((err) => { state.wf.connectorsHealth = { error: errMsg(err) }; doRerender(); });
}

function overallBadge(h) {
  if (h.status === 'error') return '<span class="badge badge-danger">Error</span>';
  if (h.status === 'disabled') return '<span class="badge badge-off">Disabled</span>';
  const lastJob = h.recentSyncJobs[0];
  if (lastJob && lastJob.status === 'failed') return '<span class="badge badge-warn">Warning</span>';
  if (h.connectorType === 'ACD' && !h.hasActiveStreamingSession) return '<span class="badge badge-warn">Not Streaming</span>';
  return '<span class="badge badge-ok">Healthy</span>';
}

export function render(state) {
  if (!state.wf.connectorsHealth) loadHealth(state);
  const list = state.wf.connectorsHealth;
  const body = !list || list.loading
    ? `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`
    : list.error
      ? `<p class="muted">${esc(list.error)}</p>`
      : list.rows.length === 0
        ? empty('No data sources yet.', '')
        : list.rows.map((h) => {
            const lastJob = h.recentSyncJobs[0];
            return `<div class="panel" style="margin-bottom:12px"><div style="padding:16px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <h3 style="margin:0">${esc(h.provider)} <span class="mono muted">(${esc(h.connectorType)})</span></h3>
                ${overallBadge(h)}
              </div>
              <table class="kv" style="margin-top:10px">
                <tr><th>Connection</th><td>${stBadge(h.status)}</td></tr>
                <tr><th>Real-Time</th><td>${h.connectorType === 'ACD' ? (h.hasActiveStreamingSession ? '<span class="badge badge-ok">Active</span>' : '<span class="badge badge-off">Not streaming</span>') : '<span class="muted">n/a (batch connector)</span>'}</td></tr>
                <tr><th>Last Sync</th><td>${h.lastSyncAt ? `${fmtDt(h.lastSyncAt)} — ${esc(h.lastSyncStatus || '—')}` : '—'}</td></tr>
                <tr><th>Last Failure</th><td>${lastJob && lastJob.status === 'failed' ? `${fmtDt(lastJob.completedAt || lastJob.startedAt)} — ${esc(JSON.stringify(lastJob.errorDetails || {}))}` : 'None'}</td></tr>
              </table>
            </div></div>`;
          }).join('');
  return `
    ${pageHead('Integration Health', 'Real connection, sync, and streaming status per data source.', `<button class="btn" data-wf="dhh-refresh">Refresh</button>`)}
    ${sec('Data Sources', body, `<span class="meta">GraphQL: connectorsHealth</span>`)}`;
}

export function handle(state, act) {
  if (act === 'dhh-refresh') { state.wf.connectorsHealth = null; return true; }
  return false;
}
