/* Data Sources → Reason Codes. Real backend: integration-hub-service's
   ReasonCode GraphQL (WP3). Saving a reason code keeps the connector's
   FieldMapping.valueMap in sync (real event translation, not a decorative
   lookup table) — see ReasonCodesService's own doc comment. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, drawerShell } from '../../identity-org/shared/ui.js';

const CODES_QUERY = `query($connectorId: ID!) { reasonCodes(connectorId: $connectorId) { id connectorId externalId reasonCode eventMode eventReason shiftOperation origin updatedAt } }`;
const UPSERT_MUTATION = `mutation Upsert($id: ID, $connectorId: ID!, $externalId: String!, $reasonCode: String!, $shiftOperation: String!, $eventMode: String, $eventReason: String, $origin: String) {
  upsertReasonCode(id: $id, connectorId: $connectorId, externalId: $externalId, reasonCode: $reasonCode, shiftOperation: $shiftOperation, eventMode: $eventMode, eventReason: $eventReason, origin: $origin) { id }
}`;
const DELETE_MUTATION = `mutation Delete($id: ID!) { deleteReasonCode(id: $id) }`;

function loadConnectorsIfNeeded(state) {
  if (state.wf.connectors) return;
  state.wf.connectors = { loading: true };
  Api.integrationHubGql(`query { connectors { id connectorType provider status } }`, {})
    .then((data) => { state.wf.connectors = { rows: data.connectors }; doRerender(); })
    .catch((err) => { state.wf.connectors = { error: errMsg(err) }; doRerender(); });
}

function loadCodes(state, connectorId) {
  state.wf.reasonCodes = { loading: true };
  Api.integrationHubGql(CODES_QUERY, { connectorId })
    .then((data) => { state.wf.reasonCodes = { rows: data.reasonCodes }; doRerender(); })
    .catch((err) => { state.wf.reasonCodes = { error: errMsg(err) }; doRerender(); });
}

function emptyDraft(connectorId) {
  return { connectorId: connectorId || '', externalId: '', reasonCode: '', shiftOperation: '', eventMode: '', eventReason: '', origin: '' };
}

export function render(state) {
  loadConnectorsIfNeeded(state);
  const connectors = (state.wf.connectors && state.wf.connectors.rows) || [];
  if (!state.dsrConnectorId && connectors.length) state.dsrConnectorId = connectors[0].id;
  if (state.dsrConnectorId && !state.wf.reasonCodes) loadCodes(state, state.dsrConnectorId);

  const list = state.wf.reasonCodes;
  const body = !state.dsrConnectorId
    ? empty('No data sources yet.', 'Create a Data Source first, then define its reason codes here.')
    : !list || list.loading
      ? `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`
      : list.error
        ? `<p class="muted">${esc(list.error)}</p>`
        : list.rows.length === 0
          ? empty('No reason codes yet.', 'Map an external reason/presence code to a WFM activity.', `<button class="btn btn-primary" data-wf="dsr-open">+ Add Reason Code</button>`)
          : `<table class="data"><thead><tr><th>ID</th><th>Reason Code</th><th>Event Mode</th><th>Event Reason</th><th>Shift Operation</th><th>Origin</th><th></th></tr></thead><tbody>
              ${list.rows.map((r) => `<tr>
                <td class="mono">${esc(r.externalId)}</td>
                <td>${esc(r.reasonCode)}</td>
                <td>${esc(r.eventMode || '—')}</td>
                <td>${esc(r.eventReason || '—')}</td>
                <td>${esc(r.shiftOperation)}</td>
                <td>${esc(r.origin || '—')}</td>
                <td class="row-actions">
                  <button class="btn btn-sm" data-wf="dsr-edit" data-id="${r.id}">Edit</button>
                  <button class="btn btn-sm btn-danger" data-wf="dsr-delete" data-id="${r.id}">Delete</button>
                </td>
              </tr>`).join('')}
            </tbody></table>`;

  return `
    ${pageHead('Reason Codes', 'External reason/presence codes mapped to WFM shift operations.', `<button class="btn btn-primary" data-wf="dsr-open" ${state.dsrConnectorId ? '' : 'disabled'}>+ Add Reason Code</button>`)}
    ${sec('Reason Codes', `
      <div class="toolbar">
        <select data-wf="dsr-select-connector">${connectors.map((c) => `<option value="${c.id}" ${state.dsrConnectorId === c.id ? 'selected' : ''}>${esc(c.provider)} (${esc(c.connectorType)})</option>`).join('')}</select>
        <button class="btn" data-wf="dsr-refresh">Refresh</button>
      </div>
      ${body}
    `)}`;
}

export function renderDrawer(state) {
  if (state.drawer !== 'dsr-edit') return '';
  const d = state.dsrDraft;
  const saving = state.wf.saving.dsrCode;
  return drawerShell(
    state.dsrEditId ? 'Edit Reason Code' : 'Add Reason Code',
    'Also updates this connector\'s field mapping so real events translate through it.',
    `
    <div class="field"><label>External ID</label><input data-wf="dsr-field" data-id="externalId" placeholder="raw code the ACD emits" value="${esc(d.externalId)}" /></div>
    <div class="field" style="margin-top:10px"><label>Reason Code</label><input data-wf="dsr-field" data-id="reasonCode" value="${esc(d.reasonCode)}" /></div>
    <div class="field" style="margin-top:10px"><label>Event Mode</label><input data-wf="dsr-field" data-id="eventMode" placeholder="e.g. not_ready" value="${esc(d.eventMode)}" /></div>
    <div class="field" style="margin-top:10px"><label>Event Reason</label><input data-wf="dsr-field" data-id="eventReason" value="${esc(d.eventReason)}" /></div>
    <div class="field" style="margin-top:10px"><label>Shift Operation</label><input data-wf="dsr-field" data-id="shiftOperation" placeholder="the WFM activity this becomes" value="${esc(d.shiftOperation)}" /></div>
    <div class="field" style="margin-top:10px"><label>Origin</label><input data-wf="dsr-field" data-id="origin" placeholder="e.g. ACD, Manual" value="${esc(d.origin)}" /></div>
    `,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="dsr-save" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save'}</button>`,
  );
}

export function handle(state, act, id, value) {
  if (act === 'dsr-select-connector') { state.dsrConnectorId = value; state.wf.reasonCodes = null; return true; }
  if (act === 'dsr-refresh') { state.wf.reasonCodes = null; return true; }

  if (act === 'dsr-open') {
    state.dsrEditId = null;
    state.dsrDraft = emptyDraft(state.dsrConnectorId);
    state.drawer = 'dsr-edit';
    return true;
  }
  if (act === 'dsr-edit') {
    const r = state.wf.reasonCodes.rows.find((x) => x.id === id);
    state.dsrEditId = id;
    state.dsrDraft = { connectorId: r.connectorId, externalId: r.externalId, reasonCode: r.reasonCode, shiftOperation: r.shiftOperation, eventMode: r.eventMode || '', eventReason: r.eventReason || '', origin: r.origin || '' };
    state.drawer = 'dsr-edit';
    return true;
  }
  if (act === 'dsr-field') { state.dsrDraft[id] = value; return true; }
  if (act === 'dsr-save') {
    const d = state.dsrDraft;
    if (!d.externalId.trim() || !d.reasonCode.trim() || !d.shiftOperation.trim()) { toast('External ID, Reason Code, and Shift Operation are required.'); return true; }
    state.wf.saving.dsrCode = true;
    doRerender();
    Api.integrationHubGql(UPSERT_MUTATION, {
      id: state.dsrEditId,
      connectorId: d.connectorId,
      externalId: d.externalId.trim(),
      reasonCode: d.reasonCode.trim(),
      shiftOperation: d.shiftOperation.trim(),
      eventMode: d.eventMode.trim() || null,
      eventReason: d.eventReason.trim() || null,
      origin: d.origin.trim() || null,
    })
      .then(() => {
        state.wf.saving.dsrCode = false;
        state.drawer = null;
        state.wf.reasonCodes = null;
        toast('Reason code saved.');
        doRerender();
      })
      .catch((err) => { state.wf.saving.dsrCode = false; toast(errMsg(err)); doRerender(); });
    return true;
  }
  if (act === 'dsr-delete') {
    if (!confirm('Delete this reason code? Its mapping will be removed from live event translation.')) return true;
    Api.integrationHubGql(DELETE_MUTATION, { id })
      .then(() => { toast('Reason code deleted.'); state.wf.reasonCodes = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
