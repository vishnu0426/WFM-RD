import { ScimInvalidFilterError } from '../errors/scim-invalid-filter.error';

export interface ParsedScimFilter {
  attribute: string;
  value: string;
}

const FILTER_PATTERN = /^\s*(\w+(?:\.\w+)?)\s+eq\s+"([^"]*)"\s*$/i;

/**
 * RFC 7644 §3.4.2.2 defines a full filter grammar (`and`/`or`/`not`,
 * `pr`/`co`/`sw`/`gt`/... operators, parenthesized groups). This platform
 * supports exactly one shape: `attribute eq "value"` - the single filter
 * every mainstream SCIM client actually sends for the two lookups
 * provisioning is built around (`userName eq "..."`, `externalId eq
 * "..."`). A filter that doesn't match this shape is rejected with a clear
 * error rather than silently ignored or partially interpreted.
 */
export function parseScimFilter(filter: string | undefined): ParsedScimFilter | null {
  if (!filter) {
    return null;
  }
  const match = FILTER_PATTERN.exec(filter);
  if (!match) {
    throw new ScimInvalidFilterError(filter);
  }
  return { attribute: match[1], value: match[2] };
}
