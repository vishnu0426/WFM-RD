/* Data Sources → Historical Data. Real backend: integration-hub-service's
   Historical Import/Backfill REST API (WP5) — real chunked/checkpointed
   SyncJob orchestration. Real, registered adapters: database (Postgres),
   mysql, genesys-cloud, avaya-axp, talkdesk, nice-cxone, five9. A provider
   with no registered adapter still fails cleanly (errorDetails.reason
   "historical_import_not_supported", surfaced below as BACKEND GAP) rather
   than a fabricated success — that gate is real and provider-agnostic
   (HistoricalAdapterRegistry), not a hardcoded allowlist in this file. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, stBadge, drawerShell, fmtDt, gap } from '../../identity-org/shared/ui.js';

function loadConnectorsIfNeeded(state) {
  if (state.wf.connectors) return;
  state.wf.connectors = { loading: true };
  Api.integrationHubGql(`query { connectors { id connectorType provider status } }`, {})
    .then((data) => { state.wf.connectors = { rows: data.connectors }; doRerender(); })
    .catch((err) => { state.wf.connectors = { error: errMsg(err) }; doRerender(); });
}

function loadJobs(state, connectorId) {
  state.wf.historicalJobs = { loading: true };
  Api.integrationHubApi(`/v1/integrations/connectors/${connectorId}/historical-imports`)
    .then((rows) => { state.wf.historicalJobs = { rows }; doRerender(); })
    .catch((err) => { state.wf.historicalJobs = { error: errMsg(err) }; doRerender(); });
}

function loadChunks(state, jobId) {
  state.wf.historicalChunks = { loading: true };
  Api.integrationHubApi(`/v1/integrations/historical-imports/${jobId}/chunks`)
    .then((rows) => { state.wf.historicalChunks = { rows }; doRerender(); })
    .catch((err) => { state.wf.historicalChunks = { error: errMsg(err) }; doRerender(); });
}

function isUnsupported(job) {
  return job.errorDetails && job.errorDetails.reason === 'historical_import_not_supported';
}

export function render(state) {
  loadConnectorsIfNeeded(state);
  const connectors = (state.wf.connectors && state.wf.connectors.rows) || [];
  if (!state.dhConnectorId && connectors.length) state.dhConnectorId = connectors[0].id;
  if (state.dhConnectorId && !state.wf.historicalJobs) loadJobs(state, state.dhConnectorId);

  const list = state.wf.historicalJobs;
  const body = !state.dhConnectorId
    ? empty('No data sources yet.', '')
    : !list || list.loading
      ? `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`
      : list.error
        ? `<p class="muted">${esc(list.error)}</p>`
        : list.rows.length === 0
          ? empty('No historical imports yet.', 'Start one below to backfill a date range of historical data.')
          : `<table class="data"><thead><tr><th>Dataset</th><th>Range</th><th>Status</th><th>Found</th><th>Processed</th><th>Failed</th><th>Duplicate</th><th></th></tr></thead><tbody>
              ${list.rows.map((j) => `<tr>
                <td class="mono">${esc(j.datasetKey)}</td>
                <td>${esc(j.rangeStart)} → ${esc(j.rangeEnd)}</td>
                <td>${stBadge(j.status)}${isUnsupported(j) ? ' <span class="badge badge-warn">BACKEND GAP</span>' : ''}</td>
                <td>${j.recordsFound ?? '—'}</td>
                <td>${j.recordsProcessed}</td>
                <td>${j.recordsFailed}</td>
                <td>${j.recordsDuplicate ?? '—'}</td>
                <td class="row-actions">
                  <button class="btn btn-sm" data-wf="dh-view-chunks" data-id="${j.id}">Chunks</button>
                  ${j.status === 'failed' && !isUnsupported(j) ? `<button class="btn btn-sm" data-wf="dh-resume" data-id="${j.id}">Resume</button>` : ''}
                  ${['queued', 'running'].includes(j.status) ? `<button class="btn btn-sm btn-danger" data-wf="dh-cancel" data-id="${j.id}">Cancel</button>` : ''}
                </td>
              </tr>${isUnsupported(j) ? `<tr><td colspan="8">${gap('Historical import is not supported for this provider yet — no adapter implements a date-ranged historical fetch.')}</td></tr>` : ''}`).join('')}
            </tbody></table>`;

  return `
    ${pageHead('Historical Data', 'Chunked, resumable historical data imports.', `<button class="btn btn-primary" data-wf="dh-open" ${state.dhConnectorId ? '' : 'disabled'}>+ Start Import</button>`)}
    ${sec('Historical Imports', `
      <div class="toolbar">
        <select data-wf="dh-select-connector">${connectors.map((c) => `<option value="${c.id}" ${state.dhConnectorId === c.id ? 'selected' : ''}>${esc(c.provider)} (${esc(c.connectorType)})</option>`).join('')}</select>
        <button class="btn" data-wf="dh-refresh">Refresh</button>
      </div>
      ${body}
    `)}`;
}

export function renderDrawer(state) {
  if (state.drawer === 'dh-start') {
    const d = state.dhDraft;
    const saving = state.wf.saving.dhStart;
    return drawerShell(
      'Start Historical Import',
      'Large ranges are chunked into 7-day windows and processed asynchronously — this never blocks on the whole range.',
      `
      <div class="field"><label>Dataset</label><input data-wf="dh-field" data-id="datasetKey" placeholder="e.g. call_volume_intervals" value="${esc(d.datasetKey)}" /></div>
      <div class="grid-2" style="margin-top:10px">
        <div class="field"><label>Start Date</label><input type="date" data-wf="dh-field" data-id="rangeStart" value="${esc(d.rangeStart)}" /></div>
        <div class="field"><label>End Date</label><input type="date" data-wf="dh-field" data-id="rangeEnd" value="${esc(d.rangeEnd)}" /></div>
      </div>
      `,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="dh-start-go" ${saving ? 'disabled' : ''}>${saving ? 'Starting…' : 'Start Import'}</button>`,
    );
  }
  if (state.drawer === 'dh-chunks') {
    if (!state.wf.historicalChunks) loadChunks(state, state.dhChunksJobId);
    const chunks = state.wf.historicalChunks;
    return drawerShell(
      'Backfill Chunks',
      'One row per date-range chunk — a failed chunk can be retried without redoing the whole range.',
      !chunks || chunks.loading
        ? '<div class="skel" style="height:20px"></div>'
        : chunks.error
          ? `<p class="muted">${esc(chunks.error)}</p>`
          : `<table class="data"><thead><tr><th>#</th><th>Range</th><th>Status</th><th>Found</th><th>Processed</th><th>Failed</th><th></th></tr></thead><tbody>
              ${chunks.rows.map((c) => `<tr>
                <td>${c.chunkIndex}</td>
                <td>${esc(c.rangeStart)} → ${esc(c.rangeEnd)}</td>
                <td>${stBadge(c.status)}</td>
                <td>${c.recordsFound}</td>
                <td>${c.recordsProcessed}</td>
                <td>${c.recordsFailed}</td>
                <td>${c.status === 'failed' ? `<button class="btn btn-sm" data-wf="dh-retry-chunk" data-id="${c.id}">Retry</button>` : ''}</td>
              </tr>`).join('')}
            </tbody></table>`,
      `<button class="btn" data-wf="close-drawer">Close</button>`,
      '',
    );
  }
  return '';
}

export function handle(state, act, id, value) {
  if (act === 'dh-select-connector') { state.dhConnectorId = value; state.wf.historicalJobs = null; return true; }
  if (act === 'dh-refresh') { state.wf.historicalJobs = null; return true; }

  if (act === 'dh-open') {
    state.dhDraft = { datasetKey: '', rangeStart: '', rangeEnd: '' };
    state.drawer = 'dh-start';
    return true;
  }
  if (act === 'dh-field') { state.dhDraft[id] = value; return true; }
  if (act === 'dh-start-go') {
    const d = state.dhDraft;
    if (!d.datasetKey.trim() || !d.rangeStart || !d.rangeEnd) { toast('Dataset, start date, and end date are required.'); return true; }
    if (d.rangeEnd < d.rangeStart) { toast('End date must not be before start date.'); return true; }
    state.wf.saving.dhStart = true;
    doRerender();
    Api.integrationHubApi(`/v1/integrations/connectors/${state.dhConnectorId}/historical-imports`, {
      method: 'POST',
      body: { datasetKey: d.datasetKey.trim(), rangeStart: d.rangeStart, rangeEnd: d.rangeEnd },
    })
      .then(() => {
        state.wf.saving.dhStart = false;
        state.drawer = null;
        state.wf.historicalJobs = null;
        toast('Historical import started.');
        doRerender();
      })
      .catch((err) => { state.wf.saving.dhStart = false; toast(errMsg(err)); doRerender(); });
    return true;
  }

  if (act === 'dh-view-chunks') {
    state.dhChunksJobId = id;
    state.wf.historicalChunks = null;
    state.drawer = 'dh-chunks';
    return true;
  }
  if (act === 'dh-retry-chunk') {
    Api.integrationHubApi(`/v1/integrations/historical-imports/chunks/${id}/retry`, { method: 'POST' })
      .then(() => { toast('Chunk queued for retry.'); state.wf.historicalChunks = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === 'dh-resume') {
    Api.integrationHubApi(`/v1/integrations/historical-imports/${id}/resume`, { method: 'POST' })
      .then(() => { toast('Import resumed.'); state.wf.historicalJobs = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === 'dh-cancel') {
    if (!confirm('Cancel this historical import?')) return true;
    Api.integrationHubApi(`/v1/integrations/historical-imports/${id}/cancel`, { method: 'POST' })
      .then(() => { toast('Import cancelled.'); state.wf.historicalJobs = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
