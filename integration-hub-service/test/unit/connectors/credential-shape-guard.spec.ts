import { assertNoRawCredentialMaterial } from '../../../src/connectors/credential-shape-guard';
import { RawCredentialInConfigError } from '../../../src/connectors/errors/raw-credential-in-config.error';

/**
 * §6's explicit test requirement: "a test asserting IntegrationConnector.config
 * rejects a raw credential value per §2.2 rule 1, for both OAuth and
 * non-OAuth paths."
 */
describe('assertNoRawCredentialMaterial', () => {
  it('allows a legitimate config shape: Vault reference path, UUID, plain strings, nested schedule object', () => {
    expect(() =>
      assertNoRawCredentialMaterial({
        credentialReference: 'integration-hub/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/conn-1/credential',
        connectorId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        oauthClientId: 'agno-wfm-connector',
        syncSchedule: { cron: '0 */6 * * *', timezone: 'UTC' },
        fieldMappingRefs: ['hire_date', 'termination_date'],
      }),
    ).not.toThrow();
  });

  it('rejects a JWT-shaped OAuth access token leaked into config', () => {
    expect(() =>
      assertNoRawCredentialMaterial({
        accessToken:
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      }),
    ).toThrow(RawCredentialInConfigError);
  });

  it('rejects a Bearer-header-shaped value leaked into config (OAuth path)', () => {
    expect(() => assertNoRawCredentialMaterial({ authHeader: 'Bearer sometoken12345' })).toThrow(
      RawCredentialInConfigError,
    );
  });

  it('rejects a known vendor API-key prefix (e.g. a Slack-shaped token) leaked into config', () => {
    expect(() => assertNoRawCredentialMaterial({ notes: 'xoxb-1234567890-abcdefghijklmnop' })).toThrow(
      RawCredentialInConfigError,
    );
  });

  it('rejects PEM-shaped private key material leaked into config (non-OAuth CMS/TSAPI path)', () => {
    expect(() =>
      assertNoRawCredentialMaterial({
        tsapiClientCert:
          '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEA\n-----END PRIVATE KEY-----',
      }),
    ).toThrow(RawCredentialInConfigError);
  });

  it('rejects a long opaque token-shaped string leaked into a nested field (non-OAuth CMS password-in-the-wrong-place case)', () => {
    expect(() =>
      assertNoRawCredentialMaterial({
        connection: { cms: { supervisorSecretLeakedHere: 'aVeryLongOpaqueLookingSecretValueThatIsNotAUuid123456' } },
      }),
    ).toThrow(RawCredentialInConfigError);
  });

  it('does not false-positive on a real OAuth CSRF state token (dot-joined tenantId.connectorId.nonce, coincidentally JWT-shaped)', () => {
    expect(() =>
      assertNoRawCredentialMaterial({
        oauthState:
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.a1b2c3d4e5f60718293a4b5c6d7e8f90',
      }),
    ).not.toThrow();
  });

  it('still rejects an opaque secret-shaped value under an unrelated field name, even one similar to oauthState', () => {
    expect(() =>
      assertNoRawCredentialMaterial({
        someOtherState: 'a1b2c3d4e5f60718293a4b5c6d7e8f9021324354657687980a1b2c3d4e5f607',
      }),
    ).toThrow(RawCredentialInConfigError);
  });

  it('rejects a raw credential inside an array element', () => {
    expect(() =>
      assertNoRawCredentialMaterial({ history: ['fine', 'AIzaSyD-fakeGoogleApiKeyShapedValue1234567890'] }),
    ).toThrow(RawCredentialInConfigError);
  });
});
