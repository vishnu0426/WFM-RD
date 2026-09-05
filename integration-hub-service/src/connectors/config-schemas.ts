import { InvalidConnectorSettingsError } from './errors/invalid-connector-settings.error';

/**
 * Tenant Admin Integration Management, WP1 (decision #1 of the plan):
 * "WFM Settings" / "Timezone Settings" / "Scorecards Settings" are real
 * backend-persisted fields, but none of them are credential material and
 * none need their own migration - they're validated, whitelisted keys
 * inside `IntegrationConnector.config.settings`, the same jsonb column
 * every other non-secret operational setting (field-mapping refs, sync
 * schedule per §2.1's own framing) already lives in. Every key here is
 * checked by `assertNoRawCredentialMaterial` same as the rest of `config`
 * before being persisted - this whitelist doesn't bypass that guard, it
 * runs in front of it.
 *
 * Recorder/Recorder-TDM/Device-IP/SIP-tracking settings (`recorderSettings`/
 * `recorderTdmSettings`/`deviceIpConfiguration`/`sipCallTracking` below) ARE
 * modeled here, on explicit request, as a real registry/documentation
 * capability - not a control plane. No on-prem telephony-hardware agent
 * exists anywhere in this platform to act on these values; see
 * `IntegrationServer`'s own doc comment for what's real about this (a
 * tenant's own deployment topology, persisted and auditable) versus what
 * isn't (nothing here opens an RMI/TDM/SIP connection).
 */
export type ConnectorSettingKey =
  | 'name'
  | 'description'
  | 'timeZone'
  | 'useAcdStaffing'
  | 'externalName'
  | 'contactViewerServerName'
  | 'contactViewerServerPort'
  | 'contactViewerUrlOverride'
  /** WP3: which raw event field this connector's Reason Codes translate (e.g. Genesys "presenceState") - defaults to "reasonCode" when unset. See `ReasonCodesService`. */
  | 'reasonCodeSourceField'
  /** WP5's Database historical-adapter follow-up: `{ [datasetKey]: sqlTemplate }` - a `database`-provider connector's own tenant-authored, per-dataset query. Never interpolated with the date range directly - `DatabaseHistoricalAdapter` always binds `rangeStart`/`rangeEnd` as `$1`/`$2` query parameters, never string concatenation. See that adapter's own doc comment. */
  | 'historicalQueries'
  /** WP5's Database historical-adapter follow-up: whether `DatabaseHistoricalAdapter` requires TLS for this connector's external database connection. Defaults to true (fail secure) when unset. */
  | 'historicalDatabaseSsl'
  /** `GenesysCloudHistoricalAdapter`'s own real, required query parameters: `{ queueIds: string[], metrics: string[], granularity?: string }` - see that adapter's own doc comment for the real Genesys Cloud Analytics API fields these map onto. */
  | 'genesysCloud'
  /** `Five9HistoricalAdapter`'s own real, required parameter: `{ folderName: string }` - the Five9 Reports Designer folder holding the report named by the historical import's own dataset key. */
  | 'five9'
  /** `NatsAcdAdapter`'s own real, required topology for subscribing to a customer's on-prem NATS bus - see that adapter's own doc comment for why `useJetStream: true` requires `streamName`/`durableName`. Auth material (`authType`/token/user-pass/nkey/creds/TLS CA) is separate, Vault-backed credential material, never in this settings object. */
  | 'onpremNats'
  /** `SftpCsvHistoricalAdapter`'s own real, required per-dataset file pattern: `{ [datasetKey]: { remoteDir, fileNamePattern, delimiter?, hasHeaderRow? } }` - see that adapter's own doc comment for the "{date}" substitution and header-row conventions. Auth (host/port/username/password-or-privateKey) is separate, Vault-backed credential material. */
  | 'sftpCsv'
  /** Integration Servers' per-connector settings - real field names/option values researched against Verint WFO/EMT's actual admin screens (see `IntegrationServer`'s own doc comment for sources). A registry/documentation value, same posture as every field in this schema - see that entity's doc comment for why nothing on this platform acts on these values. */
  | 'recorderSettings'
  | 'recorderTdmSettings'
  | 'deviceIpConfiguration'
  | 'sipCallTracking';

type SettingValidator = (value: unknown, key: string) => void;

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function stringSetting(maxLength: number): SettingValidator {
  return (value, key) => {
    if (typeof value !== 'string') {
      throw new InvalidConnectorSettingsError(`"${key}" must be a string.`);
    }
    if (value.length > maxLength) {
      throw new InvalidConnectorSettingsError(`"${key}" must be at most ${maxLength} characters.`);
    }
  };
}

function booleanSetting(value: unknown, key: string): void {
  if (typeof value !== 'boolean') {
    throw new InvalidConnectorSettingsError(`"${key}" must be a boolean.`);
  }
}

function portSetting(value: unknown, key: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new InvalidConnectorSettingsError(`"${key}" must be an integer between 1 and 65535.`);
  }
}

// `Intl.supportedValuesOf` (Node 18+) is the real IANA time zone database -
// no hand-maintained list to fall out of sync with it. Not yet in this
// project's configured TS lib target, hence the loose-typed access.
const intlWithSupportedValuesOf = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
const VALID_TIME_ZONES = new Set(
  typeof intlWithSupportedValuesOf.supportedValuesOf === 'function'
    ? intlWithSupportedValuesOf.supportedValuesOf('timeZone')
    : [],
);

function timeZoneSetting(value: unknown, key: string): void {
  if (typeof value !== 'string' || (VALID_TIME_ZONES.size > 0 && !VALID_TIME_ZONES.has(value))) {
    throw new InvalidConnectorSettingsError(`"${key}" must be a valid IANA time zone identifier (e.g. "America/New_York").`);
  }
}

const MAX_HISTORICAL_QUERY_TEMPLATE_LENGTH = 10000;

function historicalQueriesSetting(value: unknown, key: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidConnectorSettingsError(`"${key}" must be an object of { datasetKey: sqlTemplate }.`);
  }
  for (const [datasetKey, template] of Object.entries(value as Record<string, unknown>)) {
    if (typeof template !== 'string' || template.trim().length === 0) {
      throw new InvalidConnectorSettingsError(`"${key}.${datasetKey}" must be a non-empty SQL string.`);
    }
    if (template.length > MAX_HISTORICAL_QUERY_TEMPLATE_LENGTH) {
      throw new InvalidConnectorSettingsError(`"${key}.${datasetKey}" must be at most ${MAX_HISTORICAL_QUERY_TEMPLATE_LENGTH} characters.`);
    }
  }
}

function genesysCloudSetting(value: unknown, key: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidConnectorSettingsError(`"${key}" must be an object.`);
  }
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.queueIds) || v.queueIds.some((id) => typeof id !== 'string')) {
    throw new InvalidConnectorSettingsError(`"${key}.queueIds" must be an array of strings.`);
  }
  if (!Array.isArray(v.metrics) || v.metrics.some((m) => typeof m !== 'string')) {
    throw new InvalidConnectorSettingsError(`"${key}.metrics" must be an array of strings.`);
  }
  if (v.granularity !== undefined && typeof v.granularity !== 'string') {
    throw new InvalidConnectorSettingsError(`"${key}.granularity" must be a string (ISO 8601 duration, e.g. "PT30M").`);
  }
}

function five9Setting(value: unknown, key: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidConnectorSettingsError(`"${key}" must be an object.`);
  }
  if (!isNonEmptyString((value as Record<string, unknown>).folderName)) {
    throw new InvalidConnectorSettingsError(`"${key}.folderName" must be a non-empty string.`);
  }
}

const NATS_URL_PATTERN = /^(nats|tls):\/\/.+/;

function onpremNatsSetting(value: unknown, key: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidConnectorSettingsError(`"${key}" must be an object.`);
  }
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.natsUrls) || v.natsUrls.length === 0 || v.natsUrls.some((u) => typeof u !== 'string' || !NATS_URL_PATTERN.test(u))) {
    throw new InvalidConnectorSettingsError(`"${key}.natsUrls" must be a non-empty array of "nats://" or "tls://" URLs.`);
  }
  if (!isNonEmptyString(v.subject)) {
    throw new InvalidConnectorSettingsError(`"${key}.subject" must be a non-empty string.`);
  }
  if (v.queueGroup !== undefined && !isNonEmptyString(v.queueGroup)) {
    throw new InvalidConnectorSettingsError(`"${key}.queueGroup" must be a non-empty string when set.`);
  }
  if (typeof v.useJetStream !== 'boolean') {
    throw new InvalidConnectorSettingsError(`"${key}.useJetStream" must be a boolean.`);
  }
  if (v.useJetStream) {
    if (!isNonEmptyString(v.streamName)) {
      throw new InvalidConnectorSettingsError(`"${key}.streamName" is required (and must be a non-empty string) when useJetStream is true.`);
    }
    if (!isNonEmptyString(v.durableName)) {
      throw new InvalidConnectorSettingsError(`"${key}.durableName" is required (and must be a non-empty string) when useJetStream is true.`);
    }
  }
  if (v.ackWaitSeconds !== undefined && (typeof v.ackWaitSeconds !== 'number' || v.ackWaitSeconds <= 0)) {
    throw new InvalidConnectorSettingsError(`"${key}.ackWaitSeconds" must be a positive number when set.`);
  }
}

function sftpCsvSetting(value: unknown, key: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidConnectorSettingsError(`"${key}" must be an object of { datasetKey: { remoteDir, fileNamePattern, ... } }.`);
  }
  for (const [datasetKey, dataset] of Object.entries(value as Record<string, unknown>)) {
    if (typeof dataset !== 'object' || dataset === null || Array.isArray(dataset)) {
      throw new InvalidConnectorSettingsError(`"${key}.${datasetKey}" must be an object.`);
    }
    const d = dataset as Record<string, unknown>;
    if (!isNonEmptyString(d.remoteDir)) {
      throw new InvalidConnectorSettingsError(`"${key}.${datasetKey}.remoteDir" must be a non-empty string.`);
    }
    if (!isNonEmptyString(d.fileNamePattern)) {
      throw new InvalidConnectorSettingsError(`"${key}.${datasetKey}.fileNamePattern" must be a non-empty string.`);
    }
    if (d.delimiter !== undefined && (typeof d.delimiter !== 'string' || d.delimiter.length !== 1)) {
      throw new InvalidConnectorSettingsError(`"${key}.${datasetKey}.delimiter" must be a single character when set.`);
    }
    if (
      d.hasHeaderRow !== undefined &&
      typeof d.hasHeaderRow !== 'boolean' &&
      !(Array.isArray(d.hasHeaderRow) && d.hasHeaderRow.every((c) => typeof c === 'string' && c.length > 0))
    ) {
      throw new InvalidConnectorSettingsError(`"${key}.${datasetKey}.hasHeaderRow" must be a boolean, or an array of column-name strings when the file has no header row.`);
    }
  }
}

function enumSetting(allowed: readonly string[]): SettingValidator {
  return (value, key) => {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw new InvalidConnectorSettingsError(`"${key}" must be one of: ${allowed.join(', ')}.`);
    }
  };
}

function positiveIntSetting(value: unknown, key: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidConnectorSettingsError(`"${key}" must be a non-negative integer.`);
  }
}

/** Real field names/option values researched against Verint WFO/EMT's actual "Phone data source" admin screen - https://wfo.mt2.verintcloudservices.com/OnlineHelp/en_US/wfm/datasource_27003_settings.htm (confirmed live during implementation). See `IntegrationServer`'s own doc comment for the registry-not-control-plane framing. */
const SEATING_ARRANGEMENTS = ['fixed', 'free', 'hybrid'] as const;
const RECORDING_RESOURCE_ALLOCATION_BEHAVIORS = ['ignore_line', 'line_first', 'line_exclusive'] as const;
const CONTACT_POLICY_TYPES = ['follow_the_call', 'back_office_contact_per_call'] as const;
const SESSION_AUDITING_POLICIES = ['disabled', 'missed_recordings', 'full_switch'] as const;
const RECORDER_AUDIO_LOCATION_ALLOCATIONS = ['inactive', 'from_signaling', 'from_media'] as const;

function recorderSettingsSetting(value: unknown, key: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidConnectorSettingsError(`"${key}" must be an object.`);
  }
  const v = value as Record<string, unknown>;
  const optionalIntFields = [
    'maximumAllowedExtensions', 'persistAgentStateOnShutDownMinutes', 'minimumSessionLengthSeconds',
    'rollbackPeriodMinutes', 'rtpStartOverlayMs', 'rtpEndOverlayMs', 'longCallDurationMinutes',
    'longHoldDurationMinutes', 'alarmDeviceNotRecordedCallCount', 'alarmDeviceNotRecordedMs',
    'serviceObserveFailCountThreshold',
  ];
  for (const field of optionalIntFields) {
    if (v[field] !== undefined) positiveIntSetting(v[field], `${key}.${field}`);
  }
  const optionalBoolFields = ['rtpDetectionEnabled', 'alwaysReportExtensionAsPrimary', 'raiseAlarmForOutOfServiceDevices', 'keepDuplicateRecording'];
  for (const field of optionalBoolFields) {
    if (v[field] !== undefined) booleanSetting(v[field], `${key}.${field}`);
  }
  if (v.seatingArrangement !== undefined) enumSetting(SEATING_ARRANGEMENTS)(v.seatingArrangement, `${key}.seatingArrangement`);
  if (v.recordingResourceAllocationBehavior !== undefined) {
    enumSetting(RECORDING_RESOURCE_ALLOCATION_BEHAVIORS)(v.recordingResourceAllocationBehavior, `${key}.recordingResourceAllocationBehavior`);
  }
  if (v.contactPolicyType !== undefined) enumSetting(CONTACT_POLICY_TYPES)(v.contactPolicyType, `${key}.contactPolicyType`);
  if (v.sessionAuditingPolicy !== undefined) enumSetting(SESSION_AUDITING_POLICIES)(v.sessionAuditingPolicy, `${key}.sessionAuditingPolicy`);
  if (v.recorderAllocationBasedOnAudioLocation !== undefined) {
    enumSetting(RECORDER_AUDIO_LOCATION_ALLOCATIONS)(v.recorderAllocationBasedOnAudioLocation, `${key}.recorderAllocationBasedOnAudioLocation`);
  }
}

function recorderTdmSettingsSetting(value: unknown, key: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidConnectorSettingsError(`"${key}" must be an object.`);
  }
  const v = value as Record<string, unknown>;
  for (const field of ['offHookDelayMs', 'onHookDelayMs', 'interDigitDelayMs', 'periodBetweenServiceObserveMs']) {
    if (v[field] !== undefined) positiveIntSetting(v[field], `${key}.${field}`);
  }
  for (const field of ['recordExtensionsForInternalCalls', 'recordIpTrunks']) {
    if (v[field] !== undefined) booleanSetting(v[field], `${key}.${field}`);
  }
  if (v.serviceObserveString !== undefined) stringSetting(200)(v.serviceObserveString, `${key}.serviceObserveString`);
}

const DEVICE_IP_SERVER_TYPES = ['pbx_side_near_end', 'pstn_side_far_end'] as const;

function deviceIpConfigurationSetting(value: unknown, key: string): void {
  if (!Array.isArray(value)) {
    throw new InvalidConnectorSettingsError(`"${key}" must be an array of { serverType, ipAddressOrHostName }.`);
  }
  value.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new InvalidConnectorSettingsError(`"${key}[${index}]" must be an object.`);
    }
    const e = entry as Record<string, unknown>;
    enumSetting(DEVICE_IP_SERVER_TYPES)(e.serverType, `${key}[${index}].serverType`);
    if (!isNonEmptyString(e.ipAddressOrHostName)) {
      throw new InvalidConnectorSettingsError(`"${key}[${index}].ipAddressOrHostName" must be a non-empty string.`);
    }
  });
}

function sipCallTrackingSetting(value: unknown, key: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidConnectorSettingsError(`"${key}" must be an object.`);
  }
  const v = value as Record<string, unknown>;
  for (const field of ['trackSignalingCalls', 'separateCtiAndSignalingApiCommands']) {
    if (v[field] !== undefined) booleanSetting(v[field], `${key}.${field}`);
  }
  // Research confirmed this field's real name but not its enumerated option
  // values (unlike every enum above) - tenant-authored free text rather
  // than a fabricated allowlist, same honest posture as `shiftOperation`/
  // `DataSourceGroup.type` elsewhere in this codebase.
  if (v.signalingRecordingMode !== undefined) stringSetting(200)(v.signalingRecordingMode, `${key}.signalingRecordingMode`);
}

const CONNECTOR_SETTINGS_SCHEMA: Record<ConnectorSettingKey, SettingValidator> = {
  name: stringSetting(200),
  description: stringSetting(2000),
  timeZone: timeZoneSetting,
  useAcdStaffing: booleanSetting,
  externalName: stringSetting(200),
  contactViewerServerName: stringSetting(255),
  contactViewerServerPort: portSetting,
  contactViewerUrlOverride: stringSetting(2048),
  reasonCodeSourceField: stringSetting(200),
  historicalQueries: historicalQueriesSetting,
  historicalDatabaseSsl: booleanSetting,
  genesysCloud: genesysCloudSetting,
  five9: five9Setting,
  onpremNats: onpremNatsSetting,
  sftpCsv: sftpCsvSetting,
  recorderSettings: recorderSettingsSetting,
  recorderTdmSettings: recorderTdmSettingsSetting,
  deviceIpConfiguration: deviceIpConfigurationSetting,
  sipCallTracking: sipCallTrackingSetting,
};

export const DEFAULT_REASON_CODE_SOURCE_FIELD = 'reasonCode';

/**
 * Rejects unknown keys outright (fail loud, per the module's "never fake a
 * capability" rule) rather than silently dropping them - a caller sending
 * a field this module doesn't support should see an error, not a value
 * that quietly never persisted. Returns a new object; never mutates the
 * input.
 */
export function validateConnectorSettings(input: Record<string, unknown>): Partial<Record<ConnectorSettingKey, unknown>> {
  const validated: Partial<Record<ConnectorSettingKey, unknown>> = {};
  for (const [key, value] of Object.entries(input)) {
    const validator = (CONNECTOR_SETTINGS_SCHEMA as Record<string, SettingValidator | undefined>)[key];
    if (!validator) {
      throw new InvalidConnectorSettingsError(`Unknown connector setting "${key}".`);
    }
    if (value === null || value === undefined) continue;
    validator(value, key);
    validated[key as ConnectorSettingKey] = value;
  }
  if (isNonEmptyString(validated.name) === false && 'name' in validated) {
    throw new InvalidConnectorSettingsError('"name" must not be blank.');
  }
  return validated;
}
