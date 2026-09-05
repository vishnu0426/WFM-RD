/* Data Sources → Settings. Real backend: IntegrationConnector via
   integration-hub-service's GraphQL (connectors/createConnector/
   updateConnectorSettings/deleteConnector/testConnector — all real as of
   WP1). Consolidates and retires the old System Configuration → Data
   Sources screen (identity-org/system-config/data-sources.js) — same
   entity, same API, one screen instead of two confusingly similar ones. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, stBadge, drawerShell, fmtDt, gap } from '../../identity-org/shared/ui.js';

const CONNECTOR_TYPES = ['HRIS', 'PAYROLL', 'ACD', 'CRM', 'CUSTOM_WEBHOOK', 'DATABASE'];
const BATCH_TYPES = new Set(['HRIS', 'PAYROLL', 'CRM']);
const ACD_TYPES = new Set(['ACD']);

/* On-prem customer ACD publishing into their own NATS bus — the one
   streaming connector where the credential shape and connection topology
   are the customer's own infrastructure facts, not a vendor's published
   API contract, so a generic "Credentials (JSON)" textarea would just push
   the same schema knowledge onto the tenant admin with no guardrails. Real,
   labeled fields instead — same principle NatsAcdAdapter's own doc comment
   applies server-side: no generic shape, only what NATS's real API and
   JetStream's real durable-consumer model actually require. */
const NATS_ACD_PROVIDER = 'onprem-nats-acd';
const NATS_AUTH_TYPES = [
  { id: 'token', label: 'Token' },
  { id: 'userpass', label: 'Username & Password' },
  { id: 'nkey', label: 'NKey Seed' },
  { id: 'creds', label: 'Credentials File (JWT)' },
];

const LIST_QUERY = `query { connectors { id connectorType provider status lastSyncAt lastSyncStatus settings } }`;
const CREATE_MUTATION = `mutation Create(
  $connectorType: ConnectorType!, $provider: String!, $credentials: JSON,
  $oauthClientId: String, $oauthClientSecret: String, $oauthAuthorizationEndpoint: String,
  $oauthTokenEndpoint: String, $oauthRedirectUri: String, $oauthScope: String
) {
  createConnector(
    connectorType: $connectorType, provider: $provider, credentials: $credentials,
    oauthClientId: $oauthClientId, oauthClientSecret: $oauthClientSecret,
    oauthAuthorizationEndpoint: $oauthAuthorizationEndpoint, oauthTokenEndpoint: $oauthTokenEndpoint,
    oauthRedirectUri: $oauthRedirectUri, oauthScope: $oauthScope
  ) { authorizationUrl connector { id connectorType provider status } }
}`;
const UPDATE_SETTINGS_MUTATION = `mutation UpdateSettings($connectorId: ID!, $settings: JSON!) {
  updateConnectorSettings(connectorId: $connectorId, settings: $settings) { id settings }
}`;
const DELETE_MUTATION = `mutation Delete($connectorId: ID!) { deleteConnector(connectorId: $connectorId) { id status } }`;
const TEST_MUTATION = `mutation Test($connectorId: ID!) { testConnector(connectorId: $connectorId) { ok checkedAt detail } }`;

const SETTINGS_FIELDS = [
  { id: 'name', label: 'Name', type: 'text' },
  { id: 'description', label: 'Description', type: 'text' },
  { id: 'timeZone', label: 'Time Zone', type: 'text', placeholder: 'e.g. America/New_York' },
  { id: 'useAcdStaffing', label: 'Use ACD Staffing', type: 'checkbox' },
  { id: 'externalName', label: 'External Name', type: 'text' },
  { id: 'contactViewerServerName', label: 'Contact Viewer Server Name', type: 'text' },
  { id: 'contactViewerServerPort', label: 'Contact Viewer Server Port', type: 'number' },
  { id: 'contactViewerUrlOverride', label: 'Contact Viewer URL Override', type: 'text' },
  { id: 'historicalDatabaseSsl', label: 'Require TLS for Historical Database Connection', type: 'checkbox', providers: ['database', 'mysql'] },
  { id: 'historicalQueries', label: 'Historical Queries (JSON: { datasetKey: sqlTemplate }) — "$1"/"$2" placeholders for database (Postgres), "?" for mysql.', type: 'json', placeholder: '{\n  "my_dataset": "SELECT * FROM my_table WHERE ts >= $1 AND ts <= $2"\n}', providers: ['database', 'mysql'] },
  { id: 'genesysCloud', label: 'Genesys Cloud Historical Settings (JSON)', type: 'json', placeholder: '{\n  "queueIds": ["<queue-guid>"],\n  "metrics": ["tHandle", "tWait", "tAbandon"],\n  "granularity": "PT30M"\n}', providers: ['genesys-cloud'] },
  { id: 'five9', label: 'Five9 Historical Settings (JSON)', type: 'json', placeholder: '{\n  "folderName": "My Reports"\n}', providers: ['five9'] },
  { id: 'sftpCsv', label: 'SFTP/CSV Historical Settings (JSON: { datasetKey: { remoteDir, fileNamePattern, delimiter?, hasHeaderRow? } }). "{date}" in fileNamePattern is substituted per calendar day (YYYY-MM-DD).', type: 'json', placeholder: '{\n  "acd_events": {\n    "remoteDir": "/exports/acd_events",\n    "fileNamePattern": "acd_events_{date}.csv",\n    "hasHeaderRow": true\n  }\n}', providers: ['sftp-csv'] },
];

function loadConnectors(state) {
  state.wf.connectors = { loading: true };
  Api.integrationHubGql(LIST_QUERY, {})
    .then((data) => {
      state.wf.connectors = { rows: data.connectors };
      doRerender();
    })
    .catch((err) => {
      state.wf.connectors = { error: errMsg(err) };
      doRerender();
    });
}

function emptyConnectorDraft() {
  return {
    connectorType: CONNECTOR_TYPES[0],
    provider: '',
    authMode: 'credentials',
    credentialsJson: '{\n  \n}',
    oauthClientId: '',
    oauthClientSecret: '',
    oauthAuthorizationEndpoint: '',
    oauthTokenEndpoint: '',
    oauthRedirectUri: '',
    oauthScope: '',
    natsAuthType: 'token',
    natsToken: '',
    natsUser: '',
    natsPass: '',
    natsNkeySeed: '',
    natsCredsFile: '',
    natsTlsCaCert: '',
  };
}

function isNatsAcdDraft(d) {
  return d.connectorType === 'ACD' && d.provider.trim() === NATS_ACD_PROVIDER;
}

/** WFM/Timezone/Scorecards fields (no `providers` list) apply to every connector; a field naming specific `providers` only makes sense — and only renders/saves — for a connector actually using one of them. Without this, every connector's settings drawer showed every other provider's own fields (e.g. Five9's folderName box on a Talkdesk connector), which is exactly the "generic, not the real thing" shape this module otherwise avoids. */
function settingsFieldsForProvider(provider) {
  return SETTINGS_FIELDS.filter((f) => !f.providers || f.providers.includes(provider));
}

const NATS_SETTINGS_DRAFT_DEFAULTS = {
  onpremNatsUrls: '',
  onpremNatsSubject: '',
  onpremNatsQueueGroup: '',
  onpremNatsUseJetStream: false,
  onpremNatsStreamName: '',
  onpremNatsDurableName: '',
  onpremNatsAckWaitSeconds: '',
};

function settingsDraftFrom(connector) {
  const s = connector.settings || {};
  const d = {};
  SETTINGS_FIELDS.forEach((f) => {
    if (f.type === 'checkbox') { d[f.id] = !!s[f.id]; return; }
    if (f.type === 'json') { d[f.id] = s[f.id] ? JSON.stringify(s[f.id], null, 2) : ''; return; }
    d[f.id] = s[f.id] ?? '';
  });
  if (connector.provider === NATS_ACD_PROVIDER) {
    const n = s.onpremNats || {};
    Object.assign(d, NATS_SETTINGS_DRAFT_DEFAULTS, {
      onpremNatsUrls: Array.isArray(n.natsUrls) ? n.natsUrls.join('\n') : '',
      onpremNatsSubject: n.subject || '',
      onpremNatsQueueGroup: n.queueGroup || '',
      onpremNatsUseJetStream: !!n.useJetStream,
      onpremNatsStreamName: n.streamName || '',
      onpremNatsDurableName: n.durableName || '',
      onpremNatsAckWaitSeconds: n.ackWaitSeconds ?? '',
    });
  }
  return d;
}

function filteredRows(state, rows) {
  const q = (state.dsSearch || '').toLowerCase();
  return rows.filter((c) => {
    if (state.dsTypeFilter && c.connectorType !== state.dsTypeFilter) return false;
    if (state.dsStatusFilter && c.status !== state.dsStatusFilter) return false;
    if (q && !`${c.provider} ${c.connectorType}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function render(state) {
  if (!state.wf.connectors) loadConnectors(state);
  const list = state.wf.connectors;
  const body = !list || list.loading
    ? `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`
    : list.error
      ? `<p class="muted">${esc(list.error)}</p>`
      : list.rows.length === 0
        ? empty('No data sources yet.', 'Connect an HRIS, payroll, ACD, or CRM system to bring real data into WFM.', `<button class="btn btn-primary" data-wf="ds-connector-open">+ New Data Source</button>`)
        : (() => {
            const rows = filteredRows(state, list.rows);
            return `<table class="data"><thead><tr><th>Type</th><th>Provider</th><th>Status</th><th>Time Zone</th><th>Last Sync</th><th></th></tr></thead><tbody>
              ${rows.map((c) => `<tr>
                <td class="mono">${esc(c.connectorType)}</td>
                <td>${esc(c.provider)}</td>
                <td>${stBadge(c.status)}</td>
                <td>${esc((c.settings && c.settings.timeZone) || '—')}</td>
                <td>${c.lastSyncAt ? `${fmtDt(c.lastSyncAt)} (${esc(c.lastSyncStatus || '—')})` : '—'}</td>
                <td class="row-actions">
                  <button class="btn btn-sm" data-wf="ds-view" data-id="${c.id}">View</button>
                  <button class="btn btn-sm" data-wf="ds-test" data-id="${c.id}">Test Connection</button>
                  ${BATCH_TYPES.has(c.connectorType) ? `<button class="btn btn-sm" data-wf="ds-sync" data-id="${c.id}">Sync</button>` : ''}
                  <button class="btn btn-sm btn-danger" data-wf="ds-delete" data-id="${c.id}">Delete</button>
                </td>
              </tr>`).join('')}
            </tbody></table>`;
          })();
  return `
    ${pageHead('Data Sources', 'Tenant integration connectors — HRIS, payroll, ACD, CRM, and custom webhook systems.', `<button class="btn btn-primary" data-wf="ds-connector-open">+ New Data Source</button>`)}
    ${sec('Data Sources', `
      <div class="toolbar">
        <input class="search" placeholder="Search provider/type…" data-wf="ds-search" value="${esc(state.dsSearch || '')}" />
        <select data-wf="ds-type-filter"><option value="">All types</option>${CONNECTOR_TYPES.map((t) => `<option value="${t}" ${state.dsTypeFilter === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <select data-wf="ds-status-filter"><option value="">All statuses</option>${['active', 'paused', 'error', 'pending_setup', 'disabled'].map((s) => `<option value="${s}" ${state.dsStatusFilter === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <button class="btn" data-wf="ds-refresh">Refresh</button>
      </div>
      ${body}
    `, `<span class="meta">GraphQL: connectors</span>`)}`;
}

function testResultBadge(result) {
  if (!result) return '';
  return `<div class="hint" style="margin-top:10px">${result.ok ? '<span class="badge badge-ok">Connection OK</span>' : '<span class="badge badge-danger">Connection failed</span>'} ${esc(result.detail)} <span class="muted">(checked ${fmtDt(result.checkedAt)})</span></div>`;
}

function natsAuthFieldsHtml(d) {
  const perType = {
    token: `<div class="field" style="margin-top:10px"><label>Token</label><input data-wf="ds-connector-field" data-id="natsToken" type="password" value="${esc(d.natsToken)}" /></div>`,
    userpass: `<div class="grid-2" style="margin-top:10px">
        <div class="field"><label>Username</label><input data-wf="ds-connector-field" data-id="natsUser" value="${esc(d.natsUser)}" /></div>
        <div class="field"><label>Password</label><input data-wf="ds-connector-field" data-id="natsPass" type="password" value="${esc(d.natsPass)}" /></div>
      </div>`,
    nkey: `<div class="field" style="margin-top:10px"><label>NKey Seed</label><textarea data-wf="ds-connector-field" data-id="natsNkeySeed" rows="2" class="mono" placeholder="SU...">${esc(d.natsNkeySeed)}</textarea></div>`,
    creds: `<div class="field" style="margin-top:10px"><label>Credentials File (.creds contents)</label><textarea data-wf="ds-connector-field" data-id="natsCredsFile" rows="5" class="mono" placeholder="-----BEGIN NATS USER JWT-----...">${esc(d.natsCredsFile)}</textarea></div>`,
  };
  return `
    <div class="field" style="margin-top:10px"><label>NATS Authentication Type</label>
      <select data-wf="ds-connector-field" data-id="natsAuthType">${NATS_AUTH_TYPES.map((t) => `<option value="${t.id}" ${d.natsAuthType === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
      <p class="hint">Confirm with the customer's NATS operator which mechanism their on-prem server enforces — there is no way to detect it from outside.</p>
    </div>
    ${perType[d.natsAuthType] || ''}
    <div class="field" style="margin-top:10px"><label>TLS CA Certificate (optional — for a self-signed on-prem server)</label>
      <textarea data-wf="ds-connector-field" data-id="natsTlsCaCert" rows="4" class="mono" placeholder="-----BEGIN CERTIFICATE-----...">${esc(d.natsTlsCaCert)}</textarea>
    </div>`;
}

export function renderDrawer(state) {
  if (state.drawer === 'ds-connector') {
    const d = state.dsConnectorDraft;
    const saving = state.wf.saving.dsConnector;
    const isNats = isNatsAcdDraft(d);
    return drawerShell(
      'New Data Source',
      'GraphQL: createConnector — exactly one of credentials or OAuth is required',
      `
      <div class="grid-2">
        <div class="field"><label>Type</label>
          <select data-wf="ds-connector-field" data-id="connectorType">${CONNECTOR_TYPES.map((t) => `<option value="${t}" ${d.connectorType === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Provider</label><input data-wf="ds-connector-field" data-id="provider" placeholder="e.g. workday, adp, salesforce, ${NATS_ACD_PROVIDER}" value="${esc(d.provider)}" /></div>
      </div>
      ${isNats ? `
        <p class="hint" style="margin-top:10px">On-prem customer ACD via NATS — real per-mechanism auth fields below, not a generic credentials blob.</p>
        ${natsAuthFieldsHtml(d)}
      ` : `
      <div class="field" style="margin-top:10px"><label>Authentication</label>
        <select data-wf="ds-connector-field" data-id="authMode">
          <option value="credentials" ${d.authMode === 'credentials' ? 'selected' : ''}>API credentials</option>
          <option value="oauth" ${d.authMode === 'oauth' ? 'selected' : ''}>OAuth</option>
        </select>
      </div>
      ${d.authMode === 'credentials' ? `
        <div class="field" style="margin-top:10px"><label>Credentials (JSON — no fixed schema per provider)</label>
          <textarea data-wf="ds-connector-field" data-id="credentialsJson" rows="5" class="mono">${esc(d.credentialsJson)}</textarea>
        </div>` : `
        <div class="grid-2" style="margin-top:10px">
          <div class="field"><label>OAuth client ID</label><input data-wf="ds-connector-field" data-id="oauthClientId" value="${esc(d.oauthClientId)}" /></div>
          <div class="field"><label>OAuth client secret</label><input data-wf="ds-connector-field" data-id="oauthClientSecret" type="password" value="${esc(d.oauthClientSecret)}" /></div>
        </div>
        <div class="field" style="margin-top:10px"><label>Authorization endpoint</label><input data-wf="ds-connector-field" data-id="oauthAuthorizationEndpoint" value="${esc(d.oauthAuthorizationEndpoint)}" /></div>
        <div class="field" style="margin-top:10px"><label>Token endpoint</label><input data-wf="ds-connector-field" data-id="oauthTokenEndpoint" value="${esc(d.oauthTokenEndpoint)}" /></div>
        <div class="field" style="margin-top:10px"><label>Redirect URI</label><input data-wf="ds-connector-field" data-id="oauthRedirectUri" value="${esc(d.oauthRedirectUri)}" /></div>
        <div class="field" style="margin-top:10px"><label>Scope</label><input data-wf="ds-connector-field" data-id="oauthScope" value="${esc(d.oauthScope)}" /></div>`}
      `}
      `,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="ds-connector-go" ${saving ? 'disabled' : ''}>${saving ? 'Creating…' : 'Create'}</button>`,
    );
  }
  if (state.drawer === 'ds-detail') {
    const list = state.wf.connectors;
    const connector = list && list.rows ? list.rows.find((c) => c.id === state.dsDetailId) : null;
    if (!connector) return '';
    if (!state.dsSettingsDraft) state.dsSettingsDraft = settingsDraftFrom(connector);
    const d = state.dsSettingsDraft;
    const saved = settingsDraftFrom(connector);
    const dirty = JSON.stringify(d) !== JSON.stringify(saved);
    const saving = state.wf.saving.dsSettings;
    return drawerShell(
      `${connector.provider} (${connector.connectorType})`,
      `Status: ${connector.status} · id ${connector.id}`,
      `
      <h4 style="margin:0 0 8px">General / WFM / Time Zone / Scorecards Settings</h4>
      ${settingsFieldsForProvider(connector.provider).map((f) => `
        <div class="field" style="margin-top:10px">
          <label>${f.label}</label>
          ${f.type === 'checkbox'
            ? `<input type="checkbox" data-wf="ds-settings-field" data-id="${f.id}" ${d[f.id] ? 'checked' : ''} />`
            : f.type === 'json'
              ? `<textarea data-wf="ds-settings-field" data-id="${f.id}" rows="4" class="mono" placeholder="${esc(f.placeholder || '')}">${esc(d[f.id])}</textarea>`
              : `<input type="${f.type === 'number' ? 'number' : 'text'}" data-wf="ds-settings-field" data-id="${f.id}" placeholder="${esc(f.placeholder || '')}" value="${esc(d[f.id])}" />`}
        </div>`).join('')}
      ${connector.provider === NATS_ACD_PROVIDER ? `
      <h4 style="margin:20px 0 8px">On-Prem NATS ACD Settings</h4>
      <div class="field" style="margin-top:10px"><label>NATS Server URLs (one per line)</label>
        <textarea data-wf="ds-settings-field" data-id="onpremNatsUrls" rows="3" class="mono" placeholder="nats://acd-gateway.customer.local:4222">${esc(d.onpremNatsUrls)}</textarea>
      </div>
      <div class="field" style="margin-top:10px"><label>Subject</label><input data-wf="ds-settings-field" data-id="onpremNatsSubject" placeholder="acd.agent.state.&gt;" value="${esc(d.onpremNatsSubject)}" /></div>
      <div class="field" style="margin-top:10px"><label>Queue Group (optional — load-balances across multiple integration-hub-service instances)</label><input data-wf="ds-settings-field" data-id="onpremNatsQueueGroup" value="${esc(d.onpremNatsQueueGroup)}" /></div>
      <div class="field" style="margin-top:10px">
        <label><input type="checkbox" data-wf="ds-settings-field" data-id="onpremNatsUseJetStream" ${d.onpremNatsUseJetStream ? 'checked' : ''} /> Use JetStream (durable — requires JetStream enabled on the customer's own NATS server)</label>
      </div>
      ${d.onpremNatsUseJetStream ? `
        <div class="grid-2" style="margin-top:10px">
          <div class="field"><label>Stream Name</label><input data-wf="ds-settings-field" data-id="onpremNatsStreamName" value="${esc(d.onpremNatsStreamName)}" /></div>
          <div class="field"><label>Durable Consumer Name</label><input data-wf="ds-settings-field" data-id="onpremNatsDurableName" value="${esc(d.onpremNatsDurableName)}" /></div>
        </div>
        <div class="field" style="margin-top:10px"><label>Ack Wait (seconds, optional)</label><input type="number" data-wf="ds-settings-field" data-id="onpremNatsAckWaitSeconds" value="${esc(d.onpremNatsAckWaitSeconds)}" /></div>
      ` : `<p class="hint">Without JetStream, an event published while this platform is disconnected is not redelivered — confirm this is acceptable, or enable JetStream on the customer's server.</p>`}
      ` : ''}
      <h4 style="margin:20px 0 8px">Recorder Settings</h4>
      <p>${gap('No recorder/telephony-hardware config concept exists in this SaaS architecture — nothing downstream reads these fields, so they are not shown.')}</p>
      <h4 style="margin:20px 0 8px">Recorder TDM Settings</h4>
      <p>${gap('Same as Recorder Settings above.')}</p>
      <h4 style="margin:20px 0 8px">Device IP Configuration</h4>
      <p>${gap('No device-IP/hardware-address concept exists for this platform\'s connectors.')}</p>
      <h4 style="margin:20px 0 8px">SIP Call Tracking</h4>
      <p>${gap('No SIP signaling-layer concept exists — real-time capture is via the ACD provider\'s own API/relay, not raw SIP.')}</p>
      <h4 style="margin:20px 0 8px">Integration Service Associations</h4>
      <p>${gap('No Enterprise/Site/Group/Recorder hierarchy exists in this platform\'s data model.')}</p>
      ${testResultBadge(state.dsTestResult)}
      `,
      `<button class="btn" data-wf="close-drawer">Close</button><button class="btn" data-wf="ds-settings-revert" ${dirty ? '' : 'disabled'}>Revert</button>`,
      `<button class="btn btn-primary" data-wf="ds-settings-save" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>`,
    );
  }
  return '';
}

export function handle(state, act, id, value) {
  if (act === 'ds-search') { state.dsSearch = value; return true; }
  if (act === 'ds-type-filter') { state.dsTypeFilter = value; return true; }
  if (act === 'ds-status-filter') { state.dsStatusFilter = value; return true; }
  if (act === 'ds-refresh') { state.wf.connectors = null; return true; }

  if (act === 'ds-connector-open') {
    state.dsConnectorDraft = emptyConnectorDraft();
    state.drawer = 'ds-connector';
    return true;
  }
  if (act === 'ds-connector-field') { state.dsConnectorDraft[id] = value; return true; }
  if (act === 'ds-connector-go') {
    const d = state.dsConnectorDraft;
    if (!d.provider.trim()) { toast('Provider is required.'); return true; }
    const isNats = isNatsAcdDraft(d);
    let credentials;
    if (isNats) {
      if (d.natsAuthType === 'token' && !d.natsToken.trim()) { toast('Token is required.'); return true; }
      if (d.natsAuthType === 'userpass' && (!d.natsUser.trim() || !d.natsPass)) { toast('Username and password are required.'); return true; }
      if (d.natsAuthType === 'nkey' && !d.natsNkeySeed.trim()) { toast('NKey seed is required.'); return true; }
      if (d.natsAuthType === 'creds' && !d.natsCredsFile.trim()) { toast('Credentials file contents are required.'); return true; }
      credentials = { authType: d.natsAuthType };
      if (d.natsAuthType === 'token') credentials.token = d.natsToken.trim();
      if (d.natsAuthType === 'userpass') { credentials.user = d.natsUser.trim(); credentials.pass = d.natsPass; }
      if (d.natsAuthType === 'nkey') credentials.nkeySeed = d.natsNkeySeed.trim();
      if (d.natsAuthType === 'creds') credentials.credsFile = d.natsCredsFile;
      if (d.natsTlsCaCert.trim()) credentials.tlsCaCert = d.natsTlsCaCert.trim();
    } else if (d.authMode === 'credentials') {
      try { credentials = JSON.parse(d.credentialsJson); } catch { toast('Credentials must be valid JSON.'); return true; }
    }
    state.wf.saving.dsConnector = true;
    doRerender();
    Api.integrationHubGql(CREATE_MUTATION, {
      connectorType: d.connectorType,
      provider: d.provider.trim(),
      credentials: (isNats || d.authMode === 'credentials') ? credentials : undefined,
      oauthClientId: (!isNats && d.authMode === 'oauth') ? d.oauthClientId.trim() || undefined : undefined,
      oauthClientSecret: d.authMode === 'oauth' ? d.oauthClientSecret.trim() || undefined : undefined,
      oauthAuthorizationEndpoint: d.authMode === 'oauth' ? d.oauthAuthorizationEndpoint.trim() || undefined : undefined,
      oauthTokenEndpoint: d.authMode === 'oauth' ? d.oauthTokenEndpoint.trim() || undefined : undefined,
      oauthRedirectUri: d.authMode === 'oauth' ? d.oauthRedirectUri.trim() || undefined : undefined,
      oauthScope: d.authMode === 'oauth' ? d.oauthScope.trim() || undefined : undefined,
    })
      .then((data) => {
        state.wf.saving.dsConnector = false;
        state.drawer = null;
        state.wf.connectors = null;
        toast(data.createConnector.authorizationUrl ? 'Data source created — complete OAuth consent to activate it.' : 'Data source created.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.dsConnector = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'ds-view') {
    state.dsDetailId = id;
    state.dsSettingsDraft = null;
    state.dsTestResult = null;
    state.drawer = 'ds-detail';
    return true;
  }
  if (act === 'ds-settings-field') {
    const field = SETTINGS_FIELDS.find((f) => f.id === id);
    const isCheckboxField = (field && field.type === 'checkbox') || id === 'onpremNatsUseJetStream';
    // The click listener that actually fires for a checkbox (app/shell.js)
    // calls preventDefault() on every data-wf element it matches — which
    // blocks the checkbox's own native toggle (and the 'change' event that
    // would otherwise follow it), so `value` here never reflects a real
    // state change for a checkbox. Flipping the current draft value is the
    // same "toggle, don't trust the DOM value" pattern this app's other
    // dedicated toggle actions (e.g. sc-maintenance-toggle) already use.
    state.dsSettingsDraft[id] = isCheckboxField ? !state.dsSettingsDraft[id] : value;
    return true;
  }
  if (act === 'ds-settings-revert') {
    const list = state.wf.connectors;
    const connector = list.rows.find((c) => c.id === state.dsDetailId);
    state.dsSettingsDraft = settingsDraftFrom(connector);
    return true;
  }
  if (act === 'ds-settings-save') {
    const d = state.dsSettingsDraft;
    const settings = {};
    let jsonFieldError = null;
    const connectorForSave = state.wf.connectors.rows.find((c) => c.id === state.dsDetailId);
    settingsFieldsForProvider(connectorForSave ? connectorForSave.provider : '').forEach((f) => {
      if (f.type === 'checkbox') { settings[f.id] = !!d[f.id]; return; }
      if (f.type === 'number') { settings[f.id] = d[f.id] === '' ? null : Number(d[f.id]); return; }
      if (f.type === 'json') {
        if (d[f.id] === '') { settings[f.id] = null; return; }
        try { settings[f.id] = JSON.parse(d[f.id]); } catch { jsonFieldError = f.label; }
        return;
      }
      settings[f.id] = d[f.id] === '' ? null : d[f.id];
    });
    if (jsonFieldError) { toast(`"${jsonFieldError}" must be valid JSON.`); return true; }
    if (connectorForSave && connectorForSave.provider === NATS_ACD_PROVIDER) {
      if (!d.onpremNatsSubject.trim()) { toast('Subject is required.'); return true; }
      const natsUrls = d.onpremNatsUrls.split('\n').map((u) => u.trim()).filter(Boolean);
      if (natsUrls.length === 0) { toast('At least one NATS server URL is required.'); return true; }
      if (d.onpremNatsUseJetStream && (!d.onpremNatsStreamName.trim() || !d.onpremNatsDurableName.trim())) {
        toast('Stream Name and Durable Consumer Name are required when Use JetStream is checked.');
        return true;
      }
      settings.onpremNats = {
        natsUrls,
        subject: d.onpremNatsSubject.trim(),
        queueGroup: d.onpremNatsQueueGroup.trim() || undefined,
        useJetStream: !!d.onpremNatsUseJetStream,
        streamName: d.onpremNatsUseJetStream ? d.onpremNatsStreamName.trim() : undefined,
        durableName: d.onpremNatsUseJetStream ? d.onpremNatsDurableName.trim() : undefined,
        ackWaitSeconds: d.onpremNatsAckWaitSeconds === '' ? undefined : Number(d.onpremNatsAckWaitSeconds),
      };
      Object.keys(settings.onpremNats).forEach((k) => { if (settings.onpremNats[k] === undefined) delete settings.onpremNats[k]; });
    }
    Object.keys(settings).forEach((k) => { if (settings[k] === null) delete settings[k]; });
    state.wf.saving.dsSettings = true;
    doRerender();
    Api.integrationHubGql(UPDATE_SETTINGS_MUTATION, { connectorId: state.dsDetailId, settings })
      .then(() => {
        state.wf.saving.dsSettings = false;
        state.wf.connectors = null;
        toast('Settings saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.dsSettings = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'ds-test') {
    toast('Testing connection…');
    Api.integrationHubGql(TEST_MUTATION, { connectorId: id })
      .then((data) => {
        state.dsTestResult = data.testConnector;
        toast(data.testConnector.ok ? 'Connection OK.' : `Connection check failed: ${data.testConnector.detail}`);
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }

  if (act === 'ds-sync') {
    toast('Sync triggered…');
    Api.integrationHubApi(`/v1/integrations/connectors/${id}/sync`, { method: 'POST' })
      .then(() => { toast('Sync started — see Import Status for progress.'); state.wf.connectors = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }

  if (act === 'ds-delete') {
    if (!confirm('Delete this data source? It will be disabled and hidden from active lists; sync/mapping history is retained.')) return true;
    Api.integrationHubGql(DELETE_MUTATION, { connectorId: id })
      .then(() => { toast('Data source deleted.'); state.wf.connectors = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }

  return false;
}
