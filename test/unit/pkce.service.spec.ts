import { createHash } from 'node:crypto';
import { PkceService } from '../../src/modules/auth/services/pkce.service';
import { InvalidGrantError } from '../../src/modules/auth/errors/invalid-grant.error';
import { OAuthInvalidRequestError } from '../../src/modules/auth/errors/invalid-request.error';

describe('PkceService', () => {
  const service = new PkceService();
  // 43-char verifier, valid per RFC 7636 §4.1.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');

  it('computes the S256 challenge per RFC 7636 §4.2', () => {
    expect(service.computeChallenge(verifier)).toBe(challenge);
  });

  it('verify() succeeds when the verifier matches the stored challenge', () => {
    expect(() => service.verify(verifier, challenge)).not.toThrow();
  });

  it('verify() throws InvalidGrantError when the verifier does not match', () => {
    // Same length/charset as `verifier` (valid RFC 7636 format) but different
    // content, so this exercises the challenge-mismatch path, not the
    // format-validation path exercised by the test below.
    const wrongVerifier = 'A' + verifier.slice(1);
    expect(() => service.verify(wrongVerifier, challenge)).toThrow(InvalidGrantError);
  });

  it('rejects a code_verifier outside the RFC 7636 length/charset', () => {
    expect(() => service.verify('too-short', challenge)).toThrow(OAuthInvalidRequestError);
  });

  it('assertSupportedMethod rejects "plain" (OAuth2.1 forbids it - ADR-0027)', () => {
    expect(() => service.assertSupportedMethod('plain')).toThrow(OAuthInvalidRequestError);
  });

  it('assertSupportedMethod accepts "S256"', () => {
    expect(() => service.assertSupportedMethod('S256')).not.toThrow();
  });
});
