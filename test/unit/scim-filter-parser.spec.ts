import { parseScimFilter } from '../../src/modules/scim/filter/scim-filter-parser';
import { ScimInvalidFilterError } from '../../src/modules/scim/errors/scim-invalid-filter.error';

describe('parseScimFilter', () => {
  it('returns null for an undefined filter', () => {
    expect(parseScimFilter(undefined)).toBeNull();
  });

  it('parses a simple userName eq filter', () => {
    expect(parseScimFilter('userName eq "alice@example.com"')).toEqual({
      attribute: 'userName',
      value: 'alice@example.com',
    });
  });

  it('parses externalId eq, case-insensitive on the eq keyword', () => {
    expect(parseScimFilter('externalId EQ "idp-subject-123"')).toEqual({
      attribute: 'externalId',
      value: 'idp-subject-123',
    });
  });

  it('parses a dotted attribute path', () => {
    expect(parseScimFilter('name.givenName eq "Alice"')).toEqual({ attribute: 'name.givenName', value: 'Alice' });
  });

  it('rejects the full SCIM filter grammar (and/or/co/pr) this platform does not support', () => {
    expect(() => parseScimFilter('userName co "alice"')).toThrow(ScimInvalidFilterError);
    expect(() => parseScimFilter('userName eq "a" and active eq "true"')).toThrow(ScimInvalidFilterError);
    expect(() => parseScimFilter('active pr')).toThrow(ScimInvalidFilterError);
  });

  it('rejects malformed input entirely', () => {
    expect(() => parseScimFilter('not a filter')).toThrow(ScimInvalidFilterError);
  });
});
