import { Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { OAuthInvalidRequestError } from '../errors/invalid-request.error';
import { InvalidGrantError } from '../errors/invalid-grant.error';

const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * ADR-0027: OAuth2.1 mandates PKCE for every authorization_code grant and
 * forbids the `plain` challenge method entirely - `S256` only, checked both
 * here and by the `authorization_codes_pkce_s256_only` DB CHECK constraint.
 */
@Injectable()
export class PkceService {
  /** RFC 7636 §4.2: BASE64URL-ENCODE(SHA256(ASCII(code_verifier))). */
  computeChallenge(codeVerifier: string): string {
    return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  }

  assertSupportedMethod(codeChallengeMethod: string): void {
    if (codeChallengeMethod !== 'S256') {
      throw new OAuthInvalidRequestError(
        `code_challenge_method must be S256 - OAuth2.1 forbids "plain" (got: ${codeChallengeMethod}).`,
      );
    }
  }

  assertValidVerifierFormat(codeVerifier: string): void {
    if (!CODE_VERIFIER_PATTERN.test(codeVerifier)) {
      throw new OAuthInvalidRequestError(
        'code_verifier must be 43-128 characters from [A-Za-z0-9-._~] (RFC 7636 §4.1).',
      );
    }
  }

  /** Constant-time comparison so verification timing can't leak how much of the challenge matched. */
  verify(codeVerifier: string, storedChallenge: string): void {
    this.assertValidVerifierFormat(codeVerifier);
    const computed = Buffer.from(this.computeChallenge(codeVerifier));
    const stored = Buffer.from(storedChallenge);
    if (computed.length !== stored.length || !timingSafeEqual(computed, stored)) {
      throw new InvalidGrantError('PKCE verification failed: code_verifier does not match code_challenge.');
    }
  }
}
