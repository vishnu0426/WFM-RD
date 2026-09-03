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
 * Recorder/Recorder-TDM/Device-IP/SIP-tracking settings are deliberately
 * NOT modeled here - see the plan's "Integration Servers" exclusion: no
 * on-prem telephony-hardware config concept exists in this SaaS
 * architecture, so exposing those fields would mean inventing backend
 * behavior nothing downstream reads. The Data Sources UI shows those
 * sections as BACKEND GAP instead.
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
  | 'reasonCodeSourceField';

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
