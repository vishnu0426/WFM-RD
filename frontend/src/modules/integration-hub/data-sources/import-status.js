/* Data Sources → Import Status. Real backend: integration-hub-service's
   SyncJob history (syncJobHistory) + triggerManualSync — both already
   real, existing GraphQL operations (not built by this module's work). */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, stBadge, fmtDt } from '../../identity-org/shared/ui.js';

const HISTORY_QUERY = `query($connectorId: String!, $limit: Float) { syncJobHistory(connectorId: $connectorId, limit: $limit) { id connectorId syncType status recordsProcessed recordsFailed recordsConflicted errorDetails startedAt completedAt rateLimitedUntil } }`;
const TRIGGER_MUTATION = `mutation Trigger($connectorId: ID!) { triggerManualSync(connectorId: $connectorId) { id status } }`;

function loadConnectorsIfNeeded(state) {
  if (state.wf.connectors) return;
  state.wf.connectors = { loading: true };
  Api.integrationHubGql(`query { connectors { id connectorType provider status } }`, {})
    .then((data) => { state.wf.connectors = { rows: data.connectors }; doRerender(); })
    .catch((err) => { state.wf.connectors = { error: errMsg(err) }; doRerender(); });
}

function loadHistory(state, connectorId) {
  state.wf.importStatus = { loading: true };
  Api.integrationHubGql(HISTORY_QUERY, { connectorId, limit: 50 })
    .then((data) => { state.wf.importStatus = { rows: data.syncJobHistory }; doRerender(); })
    .catch((err) => { state.wf.importStatus = { error: errMsg(err) }; doRerender(); });
}

function durationOf(job) {
  if (!job.completedAt) return '—';
  const ms = new Date(job.completedAt) - new Date(job.startedAt);
  return `${Math.round(ms / 1000)}s`;
}

export function render(state) {
  loadConnectorsIfNeeded(state);
  const connectors = (state.wf.connectors && state.wf.connectors.rows) || [];
  if (!state.disConnectorId && connectors.length) state.disConnectorId = connectors[0].id;
  if (state.disConnectorId && !state.wf.importStatus) loadHistory(state, state.disConnectorId);

  const list = state.wf.importStatus;
  const selectedConnector = connectors.find((c) => c.id === state.disConnectorId);
  const canSync = selectedConnector && ['HRIS', 'PAYROLL', 'CRM'].includes(selectedConnector.connectorType);

  const body = !state.disConnectorId
    ? empty('No data sources yet.', '')
    : !list || list.loading
      ? `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`
      : list.error
        ? `<p class="muted">${esc(list.error)}</p>`
        : list.rows.length === 0
          ? empty('No import jobs yet.', 'Run Import Now, or wait for the next scheduled sync.')
          : `<table class="data"><thead><tr><th>Type</th><th>Status</th><th>Started</th><th>Completed</th><th>Duration</th><th>Processed</th><th>Failed</th><th>Error</th></tr></thead><tbody>
              ${list.rows.map((j) => `<tr>
                <td class="mono">${esc(j.syncType)}</td>
                <td>${stBadge(j.status)}${j.rateLimitedUntil && j.status === 'running' ? ' <span class="badge badge-warn">rate limited</span>' : ''}</td>
                <td>${fmtDt(j.startedAt)}</td>
                <td>${j.completedAt ? fmtDt(j.completedAt) : '—'}</td>
                <td>${durationOf(j)}</td>
                <td>${j.recordsProcessed}</td>
                <td>${j.recordsFailed}</td>
                <td class="muted">${j.errorDetails ? esc(JSON.stringify(j.errorDetails)) : '—'}</td>
              </tr>`).join('')}
            </tbody></table>`;

  return `
    ${pageHead('Import Status', 'Sync job history for this tenant’s data sources.', `<button class="btn btn-primary" data-wf="dis-sync-now" ${canSync ? '' : 'disabled'}>Import Now</button>`)}
    ${sec('Jobs', `
      <div class="toolbar">
        <select data-wf="dis-select-connector">${connectors.map((c) => `<option value="${c.id}" ${state.disConnectorId === c.id ? 'selected' : ''}>${esc(c.provider)} (${esc(c.connectorType)})</option>`).join('')}</select>
        <button class="btn" data-wf="dis-refresh">Refresh</button>
        ${!canSync && selectedConnector ? `<span class="hint">Manual sync only applies to batch connectors (HRIS/Payroll/CRM) — ${esc(selectedConnector.connectorType)} syncs via the real-time relay instead.</span>` : ''}
      </div>
      ${body}
    `)}`;
}

export function handle(state, act, id, value) {
  if (act === 'dis-select-connector') { state.disConnectorId = value; state.wf.importStatus = null; return true; }
  if (act === 'dis-refresh') { state.wf.importStatus = null; return true; }
  if (act === 'dis-sync-now') {
    toast('Import triggered…');
    Api.integrationHubGql(TRIGGER_MUTATION, { connectorId: state.disConnectorId })
      .then(() => { toast('Import started.'); state.wf.importStatus = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
