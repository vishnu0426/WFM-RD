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
import { pageHead, sec, empty, stBadge, drawerShell, fmtDt } from '../../identity-org/shared/ui.js';

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

/* Recorder / Recorder TDM / Device IP / SIP Call Tracking — real field
   names and option values researched against Verint WFO/EMT's actual
   "Phone data source" admin screen (confirmed live during implementation:
   https://wfo.mt2.verintcloudservices.com/OnlineHelp/en_US/wfm/datasource_27003_settings.htm).
   Applies to ACD/phone data sources broadly (any provider), not one
   vendor — real, discrete fields per this whole module's "no generic UI"
   principle, not a JSON blob. This is a registry, not a control plane —
   nothing on this platform reads these values to control real recording
   hardware; see integration-hub-service's IntegrationServer entity for
   the full framing. */
const RECORDER_FIELDS = [
  { id: 'seatingArrangement', label: 'Seating Arrangement', type: 'select', options: ['fixed', 'free', 'hybrid'] },
  { id: 'maximumAllowedExtensions', label: 'Maximum Allowed Extensions', type: 'number' },
  { id: 'persistAgentStateOnShutDownMinutes', label: 'Persist Agent State on Shut Down (minutes)', type: 'number' },
  { id: 'minimumSessionLengthSeconds', label: 'Minimum Session Length (seconds)', type: 'number' },
  { id: 'rollbackPeriodMinutes', label: 'Rollback Period (minutes)', type: 'number' },
  { id: 'rtpDetectionEnabled', label: 'RTP Detection', type: 'checkbox' },
  { id: 'rtpStartOverlayMs', label: 'RTP Start Overlay (ms)', type: 'number' },
  { id: 'rtpEndOverlayMs', label: 'RTP End Overlay (ms)', type: 'number' },
  { id: 'longCallDurationMinutes', label: 'Long Call Duration (minutes)', type: 'number' },
  { id: 'longHoldDurationMinutes', label: 'Long Hold Duration (minutes)', type: 'number' },
  { id: 'recordingResourceAllocationBehavior', label: 'Recording Resource Allocation Behavior', type: 'select', options: ['ignore_line', 'line_first', 'line_exclusive'] },
  { id: 'alwaysReportExtensionAsPrimary', label: 'Always Report Extension as Primary Extension', type: 'checkbox' },
  { id: 'contactPolicyType', label: 'Contact Policy Type', type: 'select', options: ['follow_the_call', 'back_office_contact_per_call'] },
  { id: 'raiseAlarmForOutOfServiceDevices', label: 'Raise Alarm for Out Of Service Devices', type: 'checkbox' },
  { id: 'alarmDeviceNotRecordedCallCount', label: 'Alarm — Device Not Recorded Call Count', type: 'number' },
  { id: 'alarmDeviceNotRecordedMs', label: 'Alarm — Device Not Recorded (ms)', type: 'number' },
  { id: 'serviceObserveFailCountThreshold', label: 'Service Observe Fail Count Threshold', type: 'number' },
  { id: 'sessionAuditingPolicy', label: 'Session Auditing Policy', type: 'select', options: ['disabled', 'missed_recordings', 'full_switch'] },
  { id: 'keepDuplicateRecording', label: 'Keep Duplicate Recording', type: 'checkbox' },
  { id: 'recorderAllocationBasedOnAudioLocation', label: 'Recorder Allocation Based On Audio Location', type: 'select', options: ['inactive', 'from_signaling', 'from_media'] },
];
const RECORDER_TDM_FIELDS = [
  { id: 'offHookDelayMs', label: 'Off Hook Delay (ms)', type: 'number' },
  { id: 'onHookDelayMs', label: 'On Hook Delay (ms)', type: 'number' },
  { id: 'serviceObserveString', label: 'Service Observe String', type: 'text' },
  { id: 'interDigitDelayMs', label: 'Inter Digit Delay (ms)', type: 'number' },
  { id: 'periodBetweenServiceObserveMs', label: 'Period Between Service Observe (ms)', type: 'number' },
  { id: 'recordExtensionsForInternalCalls', label: 'Record Extensions for Internal Calls', type: 'checkbox' },
  { id: 'recordIpTrunks', label: 'Record IP Trunks', type: 'checkbox' },
];
const SIP_CALL_TRACKING_FIELDS = [
  { id: 'trackSignalingCalls', label: 'Track Signaling Calls', type: 'checkbox' },
  { id: 'separateCtiAndSignalingApiCommands', label: 'Separate CTI and Signaling API Commands', type: 'checkbox' },
  // Verint's own field, but its real enumerated option values weren't
  // confirmable during research (unlike every select field above) —
  // tenant-authored free text rather than a guessed allowlist.
  { id: 'signalingRecordingMode', label: 'Signaling Recording Mode (tenant-authored — real option values not confirmed in public docs)', type: 'text' },
];
const DEVICE_IP_SERVER_TYPES = [
  { id: 'pbx_side_near_end', label: 'PBX Side - Near End' },
  { id: 'pstn_side_far_end', label: 'PSTN Side - Far End' },
];

function structuredFieldPrefixKey(prefix, fieldId) {
  return `${prefix}${fieldId[0].toUpperCase()}${fieldId.slice(1)}`;
}

function renderStructuredFields(fields, prefix, d) {
  return fields.map((f) => {
    const key = structuredFieldPrefixKey(prefix, f.id);
    return `<div class="field" style="margin-top:10px">
      ${f.type === 'checkbox'
        ? `<label><input type="checkbox" data-wf="ds-structured-field" data-id="${key}" ${d[key] ? 'checked' : ''} /> ${esc(f.label)}</label>`
        : `<label>${esc(f.label)}</label>
           ${f.type === 'select'
             ? `<select data-wf="ds-structured-field" data-id="${key}"><option value="">—</option>${f.options.map((o) => `<option value="${o}" ${d[key] === o ? 'selected' : ''}>${o.replace(/_/g, ' ')}</option>`).join('')}</select>`
             : `<input type="${f.type === 'number' ? 'number' : 'text'}" data-wf="ds-structured-field" data-id="${key}" value="${esc(d[key])}" />`}`}
    </div>`;
  }).join('');
}

function structuredDraftDefaults(fields, prefix) {
  const d = {};
  fields.forEach((f) => { d[structuredFieldPrefixKey(prefix, f.id)] = f.type === 'checkbox' ? false : ''; });
  return d;
}

function structuredDraftFrom(fields, prefix, source) {
  const d = {};
  fields.forEach((f) => {
    const key = structuredFieldPrefixKey(prefix, f.id);
    const v = (source || {})[f.id];
    d[key] = f.type === 'checkbox' ? !!v : (v ?? '');
  });
  return d;
}

function structuredSettingsFrom(fields, prefix, d) {
  const out = {};
  fields.forEach((f) => {
    const key = structuredFieldPrefixKey(prefix, f.id);
    const v = d[key];
    if (f.type === 'checkbox') { out[f.id] = !!v; return; }
    if (v === '') return;
    out[f.id] = f.type === 'number' ? Number(v) : v;
  });
  return out;
}

const INTEGRATION_SERVERS_QUERY = `query { integrationServers { id name serverName } }`;
const SERVERS_FOR_CONNECTOR_QUERY = `query($connectorId: ID!) { integrationServersForConnector(connectorId: $connectorId) { id serverId } }`;
const ASSOCIATE_SERVER_MUTATION = `mutation($connectorId: ID!, $serverId: ID!) { associateIntegrationServer(connectorId: $connectorId, serverId: $serverId) { id } }`;
const DISASSOCIATE_SERVER_MUTATION = `mutation($connectorId: ID!, $serverId: ID!) { disassociateIntegrationServer(connectorId: $connectorId, serverId: $serverId) }`;

function loadAllIntegrationServers(state) {
  state.wf.allIntegrationServers = { loading: true };
  Api.integrationHubGql(INTEGRATION_SERVERS_QUERY, {})
    .then((data) => { state.wf.allIntegrationServers = { rows: data.integrationServers }; doRerender(); })
    .catch((err) => { state.wf.allIntegrationServers = { error: errMsg(err) }; doRerender(); });
}

function loadServersForConnector(state, connectorId) {
  state.wf.dsServerAssociations = { loading: true };
  Api.integrationHubGql(SERVERS_FOR_CONNECTOR_QUERY, { connectorId })
    .then((data) => { state.wf.dsServerAssociations = { rows: data.integrationServersForConnector }; doRerender(); })
    .catch((err) => { state.wf.dsServerAssociations = { error: errMsg(err) }; doRerender(); });
}

function renderServerAssociations(state, connectorId) {
  if (!state.wf.allIntegrationServers) loadAllIntegrationServers(state);
  if (!state.wf.dsServerAssociations) loadServersForConnector(state, connectorId);
  const all = (state.wf.allIntegrationServers && state.wf.allIntegrationServers.rows) || [];
  const assoc = state.wf.dsServerAssociations;
  if (!assoc || assoc.loading) return `<div class="skel" style="height:20px"></div>`;
  if (assoc.error) return `<p class="muted">${esc(assoc.error)}</p>`;
  const associatedIds = new Set(assoc.rows.map((a) => a.serverId));
  const available = all.filter((s) => !associatedIds.has(s.id));
  return `
    <div class="field">
      <div style="display:flex;gap:8px">
        <select style="flex:1" data-wf="ds-server-assoc-select">
          <option value="">Select a registered Integration Server…</option>
          ${available.map((s) => `<option value="${s.id}">${esc(s.name)} (${esc(s.serverName)})</option>`).join('')}
        </select>
        <button class="btn" data-wf="ds-server-assoc-add">Associate</button>
      </div>
    </div>
    ${assoc.rows.length === 0 ? '<p class="muted" style="margin-top:8px">No registered servers associated with this data source yet.</p>' : `
      <table class="data" style="margin-top:10px"><thead><tr><th>Server</th><th></th></tr></thead><tbody>
        ${assoc.rows.map((a) => {
          const s = all.find((x) => x.id === a.serverId);
          return `<tr><td>${esc(s ? `${s.name} (${s.serverName})` : a.serverId)}</td><td><button class="btn btn-sm btn-danger" data-wf="ds-server-assoc-remove" data-id="${a.serverId}">Remove</button></td></tr>`;
        }).join('')}
      </tbody></table>`}
  `;
}

/* Real, named credential (Vault-bound) and config (non-secret,
   `additionalConfig` -> `connector.config`) fields per real, already-
   implemented provider - pulled directly from each adapter's own
   TypeScript credential/config interface (sync/relay/providers/*.ts,
   sync/historical/providers/*.ts, sync/batch/providers/*.ts), not
   guessed. Replaces one generic "Credentials (JSON)" textarea for every
   provider with the actual fields each one's own adapter code reads.
   Streaming and historical adapters for the "same" vendor use different
   literal `provider` strings today (a pre-existing inconsistency - the
   streaming registry keys on a human-readable name, the historical one
   on kebab-case) - both are listed here as distinct, clearly-labeled
   catalog entries rather than papered over, since creating one connector
   only ever matches one of the two registries. */
const PROVIDER_CATALOG = [
  { value: 'workday', label: 'Workday — HRIS (Batch Sync)', connectorType: 'HRIS',
    credentialFields: [{ id: 'accessToken', label: 'Access Token', type: 'password' }] },
  { value: 'adp', label: 'ADP — Payroll (Batch Sync)', connectorType: 'PAYROLL',
    credentialFields: [
      { id: 'accessToken', label: 'Access Token', type: 'password' },
      { id: 'clientCertPem', label: 'Client Certificate (PEM)', type: 'textarea' },
      { id: 'clientKeyPem', label: 'Client Private Key (PEM)', type: 'textarea' },
    ] },
  { value: 'salesforce', label: 'Salesforce — CRM (Batch Sync)', connectorType: 'CRM',
    credentialFields: [{ id: 'accessToken', label: 'Access Token', type: 'password' }] },
  { value: 'sap-successfactors', label: 'SAP SuccessFactors — HRIS (Batch Sync)', connectorType: 'HRIS',
    credentialFields: [{ id: 'accessToken', label: 'Access Token', type: 'password' }] },
  { value: 'database', label: 'Database — Postgres (Historical Import)', connectorType: 'DATABASE',
    credentialFields: [
      { id: 'host', label: 'Host', type: 'text' },
      { id: 'port', label: 'Port (default 5432)', type: 'number', optional: true },
      { id: 'database', label: 'Database Name', type: 'text' },
      { id: 'username', label: 'Username', type: 'text' },
      { id: 'password', label: 'Password', type: 'password' },
    ] },
  { value: 'mysql', label: 'MySQL (Historical Import)', connectorType: 'DATABASE',
    credentialFields: [
      { id: 'host', label: 'Host', type: 'text' },
      { id: 'port', label: 'Port (default 3306)', type: 'number', optional: true },
      { id: 'database', label: 'Database Name', type: 'text' },
      { id: 'username', label: 'Username', type: 'text' },
      { id: 'password', label: 'Password', type: 'password' },
    ] },
  { value: 'sftp-csv', label: 'SFTP / CSV File Drop (Historical Import)', connectorType: 'DATABASE',
    credentialFields: [
      { id: 'host', label: 'Host', type: 'text' },
      { id: 'port', label: 'Port (default 22)', type: 'number', optional: true },
      { id: 'username', label: 'Username', type: 'text' },
      { id: 'password', label: 'Password (leave blank if using a private key)', type: 'password', optional: true },
      { id: 'privateKey', label: 'Private Key (leave blank if using a password)', type: 'textarea', optional: true },
      { id: 'passphrase', label: 'Private Key Passphrase (optional)', type: 'password', optional: true },
    ] },
  { value: 'genesys-cloud', label: 'Genesys Cloud (Historical Import)', connectorType: 'ACD',
    credentialFields: [
      { id: 'region', label: 'Org Region (e.g. mypurecloud.com)', type: 'text' },
      { id: 'clientId', label: 'Client ID', type: 'text' },
      { id: 'clientSecret', label: 'Client Secret', type: 'password' },
    ] },
  { value: 'avaya-axp', label: 'Avaya Experience Platform (Historical Import)', connectorType: 'ACD',
    credentialFields: [
      { id: 'region', label: 'Region (e.g. use1, euw1)', type: 'text' },
      { id: 'accountId', label: 'Account ID', type: 'text' },
      { id: 'clientId', label: 'Client ID', type: 'text' },
      { id: 'clientSecret', label: 'Client Secret', type: 'password' },
    ] },
  { value: 'talkdesk', label: 'Talkdesk (Historical Import)', connectorType: 'ACD',
    credentialFields: [
      { id: 'clientId', label: 'Client ID', type: 'text' },
      { id: 'clientSecret', label: 'Client Secret', type: 'password' },
      { id: 'tokenUrl', label: 'Token URL (from your Talkdesk admin settings)', type: 'text' },
      { id: 'apiBaseUrl', label: 'API Base URL (from your Talkdesk admin settings)', type: 'text' },
    ] },
  { value: 'nice-cxone', label: 'NICE CXone (Historical Import)', connectorType: 'ACD',
    credentialFields: [
      { id: 'region', label: 'Region (e.g. na1, eu1)', type: 'text' },
      { id: 'clientId', label: 'Client ID', type: 'text' },
      { id: 'clientSecret', label: 'Client Secret', type: 'password' },
      { id: 'apiVersion', label: 'API Version (optional, default 20.0)', type: 'text', optional: true },
    ] },
  { value: 'five9', label: 'Five9 (Historical Import)', connectorType: 'ACD',
    credentialFields: [
      { id: 'username', label: 'Username', type: 'text' },
      { id: 'password', label: 'Password', type: 'password' },
      { id: 'apiVersion', label: 'API Version (optional, default 9_5)', type: 'text', optional: true },
    ] },
  { value: 'Genesys Cloud', label: 'Genesys Cloud (Real-Time Streaming)', connectorType: 'ACD',
    credentialFields: [
      { id: 'clientId', label: 'Client ID', type: 'text' },
      { id: 'clientSecret', label: 'Client Secret', type: 'password' },
    ],
    configFields: [
      { id: 'genesysApiBaseUrl', label: 'API Base URL (e.g. https://api.mypurecloud.com)', type: 'text' },
      { id: 'genesysUserIds', label: 'Genesys User IDs to monitor (comma-separated)', type: 'text', array: true },
    ] },
  { value: 'Avaya Aura Contact Center / CMS', label: 'Avaya Aura (Real-Time Streaming)', connectorType: 'ACD',
    credentialFields: [{ id: 'securityToken', label: 'Security Token', type: 'password' }],
    configFields: [
      { id: 'aesHost', label: 'AES Host', type: 'text' },
      { id: 'aesPort', label: 'AES Port', type: 'number' },
      { id: 'monitoredDeviceIds', label: 'Device IDs to monitor (comma-separated)', type: 'text', array: true },
    ] },
  { value: 'NICE CXone', label: 'NICE CXone (Real-Time Streaming)', connectorType: 'ACD',
    credentialFields: [
      { id: 'username', label: 'Username (use with Password, or use Client ID/Secret instead)', type: 'text', optional: true },
      { id: 'password', label: 'Password', type: 'password', optional: true },
      { id: 'clientId', label: 'Client ID (use with Client Secret, or use Username/Password instead)', type: 'text', optional: true },
      { id: 'clientSecret', label: 'Client Secret', type: 'password', optional: true },
    ],
    configFields: [
      { id: 'niceApiBaseUrl', label: 'API Base URL', type: 'text' },
      { id: 'niceAgentIds', label: 'Agent IDs to monitor (comma-separated)', type: 'text', array: true },
    ] },
  { value: 'Five9', label: 'Five9 (Real-Time Streaming)', connectorType: 'ACD',
    credentialFields: [
      { id: 'username', label: 'Username', type: 'text' },
      { id: 'password', label: 'Password', type: 'password' },
    ],
    configFields: [{ id: 'five9ApiBaseUrl', label: 'API Base URL', type: 'text' }] },
  { value: 'Talkdesk', label: 'Talkdesk (Real-Time Streaming)', connectorType: 'ACD',
    credentialFields: [
      { id: 'clientId', label: 'Client ID', type: 'text' },
      { id: 'clientSecret', label: 'Client Secret', type: 'password' },
    ],
    configFields: [{ id: 'talkdeskApiBaseUrl', label: 'API Base URL', type: 'text' }] },
  { value: 'Avaya Experience Platform', label: 'Avaya Experience Platform (Real-Time Streaming)', connectorType: 'ACD',
    credentialFields: [
      { id: 'clientId', label: 'Client ID', type: 'text' },
      { id: 'clientSecret', label: 'Client Secret', type: 'password' },
    ],
    configFields: [
      { id: 'axpApiBaseUrl', label: 'API Base URL', type: 'text' },
      { id: 'axpAccountId', label: 'Account ID', type: 'text' },
    ] },
  { value: NATS_ACD_PROVIDER, label: 'On-Prem NATS ACD (Real-Time Streaming)', connectorType: 'ACD', special: 'nats' },
  { value: '__custom__', label: 'Custom / Other (advanced — raw JSON credentials)', connectorType: null, special: 'custom' },
];

function providerCatalogEntry(providerValue) {
  return PROVIDER_CATALOG.find((p) => p.value === providerValue) || null;
}

const LIST_QUERY = `query { connectors { id connectorType provider status lastSyncAt lastSyncStatus settings } }`;
const CREATE_MUTATION = `mutation Create(
  $connectorType: ConnectorType!, $provider: String!, $credentials: JSON, $additionalConfig: JSON,
  $oauthClientId: String, $oauthClientSecret: String, $oauthAuthorizationEndpoint: String,
  $oauthTokenEndpoint: String, $oauthRedirectUri: String, $oauthScope: String
) {
  createConnector(
    connectorType: $connectorType, provider: $provider, credentials: $credentials, additionalConfig: $additionalConfig,
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
    customProvider: '',
    credentialFieldValues: {},
    configFieldValues: {},
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
  if (connector.connectorType === 'ACD') {
    Object.assign(d, structuredDraftFrom(RECORDER_FIELDS, 'rec', s.recorderSettings));
    Object.assign(d, structuredDraftFrom(RECORDER_TDM_FIELDS, 'tdm', s.recorderTdmSettings));
    Object.assign(d, structuredDraftFrom(SIP_CALL_TRACKING_FIELDS, 'sip', s.sipCallTracking));
    d.deviceIpConfigs = Array.isArray(s.deviceIpConfiguration)
      ? s.deviceIpConfiguration.map((e) => ({ serverType: e.serverType || '', ipAddressOrHostName: e.ipAddressOrHostName || '' }))
      : [];
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

function catalogFieldsHtml(fields, values, action) {
  return fields.map((f) => `
    <div class="field" style="margin-top:10px">
      <label>${esc(f.label)}</label>
      ${f.type === 'textarea'
        ? `<textarea data-wf="${action}" data-id="${f.id}" rows="3" class="mono">${esc(values[f.id] || '')}</textarea>`
        : `<input type="${f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text'}" data-wf="${action}" data-id="${f.id}" value="${esc(values[f.id] || '')}" />`}
    </div>`).join('');
}

export function renderDrawer(state) {
  if (state.drawer === 'ds-connector') {
    const d = state.dsConnectorDraft;
    const saving = state.wf.saving.dsConnector;
    const entry = providerCatalogEntry(d.provider);
    const isNats = entry && entry.special === 'nats';
    const isCustom = entry && entry.special === 'custom';
    return drawerShell(
      'New Data Source',
      'GraphQL: createConnector — real, named fields per provider, not a generic credentials blob',
      `
      <div class="grid-2">
        <div class="field"><label>Type</label>
          <select data-wf="ds-connector-field" data-id="connectorType">${CONNECTOR_TYPES.map((t) => `<option value="${t}" ${d.connectorType === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Provider</label>
          <select data-wf="ds-connector-field" data-id="provider">
            <option value="" ${d.provider === '' ? 'selected' : ''}>Select a provider…</option>
            ${PROVIDER_CATALOG.map((p) => `<option value="${esc(p.value)}" ${d.provider === p.value ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      ${isCustom ? `
        <div class="field" style="margin-top:10px"><label>Provider Name (sent to the backend exactly as typed)</label>
          <input data-wf="ds-connector-field" data-id="customProvider" placeholder="e.g. my-internal-system" value="${esc(d.customProvider)}" />
        </div>
        <div class="field" style="margin-top:10px"><label>Authentication</label>
          <select data-wf="ds-connector-field" data-id="authMode">
            <option value="credentials" ${d.authMode === 'credentials' ? 'selected' : ''}>API credentials</option>
            <option value="oauth" ${d.authMode === 'oauth' ? 'selected' : ''}>OAuth</option>
          </select>
        </div>
        ${d.authMode === 'credentials' ? `
          <div class="field" style="margin-top:10px"><label>Credentials (JSON — no adapter exists yet for a custom provider, so no fixed field list either)</label>
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
      ` : isNats ? `
        <p class="hint" style="margin-top:10px">On-prem customer ACD via NATS — real per-mechanism auth fields below, not a generic credentials blob.</p>
        ${natsAuthFieldsHtml(d)}
      ` : entry ? `
        <h4 style="margin:16px 0 0">Credentials</h4>
        ${catalogFieldsHtml(entry.credentialFields, d.credentialFieldValues, 'ds-credential-field')}
        ${entry.configFields ? `
          <h4 style="margin:16px 0 0">Connection Settings</h4>
          ${catalogFieldsHtml(entry.configFields, d.configFieldValues, 'ds-config-field')}
        ` : ''}
      ` : ''}
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
      ${connector.connectorType === 'ACD' ? `
      <p class="hint" style="margin-top:16px">Recorder/TDM/Device IP/SIP Call Tracking below are a real, persisted registry of your own on-prem recording infrastructure (real field names from Verint WFO/EMT's own admin screens) — not a live control plane. Nothing on this platform acts on these values; see Integration Servers for the same framing.</p>
      <h4 style="margin:16px 0 8px">Recorder Settings</h4>
      ${renderStructuredFields(RECORDER_FIELDS, 'rec', d)}
      <h4 style="margin:20px 0 8px">Recorder TDM Settings</h4>
      ${renderStructuredFields(RECORDER_TDM_FIELDS, 'tdm', d)}
      <h4 style="margin:20px 0 8px">Device IP Configuration</h4>
      ${d.deviceIpConfigs.map((e, i) => `
        <div class="grid-2" style="margin-top:10px">
          <div class="field"><label>Server Type</label>
            <select data-wf="ds-device-ip-field" data-id="${i}:serverType">${DEVICE_IP_SERVER_TYPES.map((t) => `<option value="${t.id}" ${e.serverType === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
          </div>
          <div class="field"><label>IP Address / Host Name</label>
            <div style="display:flex;gap:8px">
              <input style="flex:1" data-wf="ds-device-ip-field" data-id="${i}:ipAddressOrHostName" value="${esc(e.ipAddressOrHostName)}" />
              <button class="btn btn-sm btn-danger" data-wf="ds-device-ip-remove" data-id="${i}">Remove</button>
            </div>
          </div>
        </div>`).join('')}
      <button class="btn btn-sm" style="margin-top:10px" data-wf="ds-device-ip-add">+ Add Device IP Configuration</button>
      <h4 style="margin:20px 0 8px">SIP Call Tracking</h4>
      ${renderStructuredFields(SIP_CALL_TRACKING_FIELDS, 'sip', d)}
      <h4 style="margin:20px 0 8px">Integration Service Associations</h4>
      ${renderServerAssociations(state, connector.id)}
      ` : ''}
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
  if (act === 'ds-connector-field') {
    state.dsConnectorDraft[id] = value;
    if (id === 'provider') {
      const entry = providerCatalogEntry(value);
      if (entry && entry.connectorType) state.dsConnectorDraft.connectorType = entry.connectorType;
      state.dsConnectorDraft.credentialFieldValues = {};
      state.dsConnectorDraft.configFieldValues = {};
    }
    return true;
  }
  if (act === 'ds-credential-field') { state.dsConnectorDraft.credentialFieldValues[id] = value; return true; }
  if (act === 'ds-config-field') { state.dsConnectorDraft.configFieldValues[id] = value; return true; }
  if (act === 'ds-connector-go') {
    const d = state.dsConnectorDraft;
    if (!d.provider) { toast('Select a provider.'); return true; }
    const entry = providerCatalogEntry(d.provider);
    const isNats = entry && entry.special === 'nats';
    const isCustom = entry && entry.special === 'custom';
    const providerValue = isCustom ? d.customProvider.trim() : d.provider;
    if (!providerValue) { toast('Provider name is required.'); return true; }
    let credentials;
    let additionalConfig;
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
    } else if (isCustom) {
      if (d.authMode === 'credentials') {
        try { credentials = JSON.parse(d.credentialsJson); } catch { toast('Credentials must be valid JSON.'); return true; }
      }
    } else if (entry) {
      credentials = {};
      for (const f of entry.credentialFields) {
        const v = d.credentialFieldValues[f.id];
        if (v === undefined || v === '') continue;
        credentials[f.id] = f.type === 'number' ? Number(v) : v;
      }
      for (const f of entry.credentialFields) {
        if (!f.optional && (credentials[f.id] === undefined || credentials[f.id] === '')) {
          toast(`"${f.label}" is required.`);
          return true;
        }
      }
      if (entry.configFields) {
        additionalConfig = {};
        for (const f of entry.configFields) {
          const v = d.configFieldValues[f.id];
          if (v === undefined || v === '') continue;
          additionalConfig[f.id] = f.array ? v.split(',').map((s) => s.trim()).filter(Boolean) : (f.type === 'number' ? Number(v) : v);
        }
        for (const f of entry.configFields) {
          const v = additionalConfig[f.id];
          if (v === undefined || (Array.isArray(v) && v.length === 0)) {
            toast(`"${f.label}" is required.`);
            return true;
          }
        }
      }
    }
    state.wf.saving.dsConnector = true;
    doRerender();
    Api.integrationHubGql(CREATE_MUTATION, {
      connectorType: d.connectorType,
      provider: providerValue,
      credentials: (isNats || entry) ? credentials : (d.authMode === 'credentials' ? credentials : undefined),
      additionalConfig,
      oauthClientId: (isCustom && d.authMode === 'oauth') ? d.oauthClientId.trim() || undefined : undefined,
      oauthClientSecret: (isCustom && d.authMode === 'oauth') ? d.oauthClientSecret.trim() || undefined : undefined,
      oauthAuthorizationEndpoint: (isCustom && d.authMode === 'oauth') ? d.oauthAuthorizationEndpoint.trim() || undefined : undefined,
      oauthTokenEndpoint: (isCustom && d.authMode === 'oauth') ? d.oauthTokenEndpoint.trim() || undefined : undefined,
      oauthRedirectUri: (isCustom && d.authMode === 'oauth') ? d.oauthRedirectUri.trim() || undefined : undefined,
      oauthScope: (isCustom && d.authMode === 'oauth') ? d.oauthScope.trim() || undefined : undefined,
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
    state.wf.dsServerAssociations = null;
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
  if (act === 'ds-structured-field') {
    const [prefix, fields] = id.startsWith('rec') ? ['rec', RECORDER_FIELDS] : id.startsWith('tdm') ? ['tdm', RECORDER_TDM_FIELDS] : ['sip', SIP_CALL_TRACKING_FIELDS];
    const field = fields.find((f) => structuredFieldPrefixKey(prefix, f.id) === id);
    const isCheckboxField = field && field.type === 'checkbox';
    state.dsSettingsDraft[id] = isCheckboxField ? !state.dsSettingsDraft[id] : value;
    return true;
  }
  if (act === 'ds-device-ip-field') {
    const [indexStr, field] = id.split(':');
    state.dsSettingsDraft.deviceIpConfigs[Number(indexStr)][field] = value;
    return true;
  }
  if (act === 'ds-device-ip-add') {
    state.dsSettingsDraft.deviceIpConfigs.push({ serverType: DEVICE_IP_SERVER_TYPES[0].id, ipAddressOrHostName: '' });
    return true;
  }
  if (act === 'ds-device-ip-remove') {
    state.dsSettingsDraft.deviceIpConfigs.splice(Number(id), 1);
    return true;
  }
  if (act === 'ds-server-assoc-select') { state.dsServerAssocSelectId = value; return true; }
  if (act === 'ds-server-assoc-add') {
    if (!state.dsServerAssocSelectId) { toast('Select a server first.'); return true; }
    Api.integrationHubGql(ASSOCIATE_SERVER_MUTATION, { connectorId: state.dsDetailId, serverId: state.dsServerAssocSelectId })
      .then(() => { toast('Server associated.'); state.wf.dsServerAssociations = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === 'ds-server-assoc-remove') {
    Api.integrationHubGql(DISASSOCIATE_SERVER_MUTATION, { connectorId: state.dsDetailId, serverId: id })
      .then(() => { toast('Server disassociated.'); state.wf.dsServerAssociations = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
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
    if (connectorForSave && connectorForSave.connectorType === 'ACD') {
      settings.recorderSettings = structuredSettingsFrom(RECORDER_FIELDS, 'rec', d);
      settings.recorderTdmSettings = structuredSettingsFrom(RECORDER_TDM_FIELDS, 'tdm', d);
      settings.sipCallTracking = structuredSettingsFrom(SIP_CALL_TRACKING_FIELDS, 'sip', d);
      for (const e of d.deviceIpConfigs) {
        if (!e.ipAddressOrHostName.trim()) { toast('IP Address / Host Name is required for every Device IP Configuration row.'); return true; }
      }
      settings.deviceIpConfiguration = d.deviceIpConfigs.map((e) => ({ serverType: e.serverType, ipAddressOrHostName: e.ipAddressOrHostName.trim() }));
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
