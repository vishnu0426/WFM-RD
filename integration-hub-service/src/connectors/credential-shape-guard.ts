import { RawCredentialInConfigError } from './errors/raw-credential-in-config.error';

/**
 * §2.2 rule 1, ADR-0134: "a validation check on IntegrationConnector
 * create/update that rejects any payload attempting to store what looks
 * like a raw credential (API key pattern, token pattern) in `config`
 * directly." Provider-agnostic pattern matching, not a provider allowlist
 * (ADR-0134) - applies identically to the OAuth path (catches a token that
 * should have gone to Vault but leaked into `config` instead) and the
 * non-OAuth path (catches CMS/TSAPI-style credential material the same
 * way). Runs against the config object actually about to be persisted -
 * i.e. AFTER the caller's real credential-bearing fields (`credentials`,
 * `oauthClientSecret`) have already been extracted and sent to Vault, not
 * against the raw mutation input.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PEM_PATTERN = /-----BEGIN [A-Z0-9 ]+-----/;
const JWT_PATTERN = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const AUTH_HEADER_PATTERN = /^(Bearer|Basic)\s+\S+/i;
// A deliberately non-exhaustive set of well-known vendor API-key prefixes -
// enough to catch the common accidental-paste case, not meant to be a
// complete registry (ADR-0134's own point: pattern matching, not an
// allowlist of every possible shape).
const KNOWN_API_KEY_PREFIX_PATTERN = /^(sk-|pk-|xox[baprs]-|gh[ptous]_|AIza|glpat-|AKIA)/;
// A long run of pure base64/hex-alphabet characters with no hyphens or
// slashes - excludes UUIDs (which use hyphens) and Vault reference paths
// (which use slashes), the two legitimate long-string shapes `config` is
// expected to hold.
const OPAQUE_SECRET_PATTERN = /^[A-Za-z0-9+=]{40,}$/;
// Fields this module's own framework code is known to populate with a
// non-secret opaque value (a CSRF state/nonce, not a credential) - a
// narrow exemption by field name, not a provider allowlist (ADR-0134 rules
// out the latter, not the former). A real API key/token would have to
// coincidentally be named exactly one of these AND appear in a connector's
// config to slip past this exemption, and would still be caught by the
// PEM/JWT/Bearer/known-prefix checks above regardless of field name.
const KNOWN_SAFE_OPAQUE_FIELD_NAMES = new Set(['oauthState']);

function checkStringValue(value: string, fieldPath: string): void {
  const leafFieldName = fieldPath.split(/[.[]/).pop() ?? fieldPath;
  // Checked first, before any pattern: this module's own generated values
  // under these field names (e.g. `oauthState`'s `tenantId.connectorId.nonce`
  // shape, which is dot-segmented and can coincidentally match the JWT
  // pattern below) are known-safe by construction, regardless of which
  // heuristic they'd otherwise trip.
  if (KNOWN_SAFE_OPAQUE_FIELD_NAMES.has(leafFieldName)) return;
  if (UUID_PATTERN.test(value)) return;
  if (PEM_PATTERN.test(value)) throw new RawCredentialInConfigError(fieldPath, 'PEM key/certificate material');
  if (JWT_PATTERN.test(value)) throw new RawCredentialInConfigError(fieldPath, 'JWT-shaped token');
  if (AUTH_HEADER_PATTERN.test(value))
    throw new RawCredentialInConfigError(fieldPath, 'Bearer/Basic auth header value');
  if (KNOWN_API_KEY_PREFIX_PATTERN.test(value)) {
    throw new RawCredentialInConfigError(fieldPath, 'known vendor API-key prefix');
  }
  if (OPAQUE_SECRET_PATTERN.test(value)) {
    throw new RawCredentialInConfigError(fieldPath, 'long opaque token-shaped string');
  }
}

function walk(value: unknown, fieldPath: string): void {
  if (typeof value === 'string') {
    checkStringValue(value, fieldPath);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${fieldPath}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      walk(nested, fieldPath ? `${fieldPath}.${key}` : key);
    }
  }
}

/** Throws `RawCredentialInConfigError` on the first match found; otherwise returns normally. */
export function assertNoRawCredentialMaterial(config: Record<string, unknown>): void {
  walk(config, '');
}
