import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { WebAuthnCredentialsRepository } from '../repositories/webauthn-credentials.repository';
import { WebAuthnChallengeService } from './webauthn-challenge.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { WebAuthnSessionService } from '../../auth/services/webauthn-session.service';
import { AuthMethodPolicyService } from '../../auth/services/auth-method-policy.service';
import { WebAuthnCredential } from '../entities/webauthn-credential.entity';
import { WebAuthnDeviceType } from '../entities/webauthn-device-type.enum';
import { WebAuthnChallengeExpiredError } from '../errors/webauthn-challenge-expired.error';
import { WebAuthnVerificationFailedError } from '../errors/webauthn-verification-failed.error';

/**
 * §5.4's WebAuthn/Passkeys ceremonies, via `@simplewebauthn/server`. `rpID`/
 * `origin` describe the *browser-facing frontend* that would run
 * `navigator.credentials.create()`/`.get()` - this repo has no frontend
 * (same posture as ADR-0026's password-auth simplification), so these are
 * configured via env vars a real deployment must set to match whatever
 * frontend actually serves the WebAuthn JS, not derived from this backend's
 * own `OIDC_ISSUER`.
 */
@Injectable()
export class WebAuthnService {
  private readonly rpName: string;
  private readonly rpID: string;
  private readonly origin: string;

  constructor(
    private readonly credentials: WebAuthnCredentialsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly challenges: WebAuthnChallengeService,
    private readonly webauthnSessions: WebAuthnSessionService,
    private readonly authMethodPolicy: AuthMethodPolicyService,
    config: ConfigService,
  ) {
    this.rpName = config.get<string>('WEBAUTHN_RP_NAME', 'AGNO WFM');
    this.rpID = config.get<string>('WEBAUTHN_RP_ID', 'localhost');
    this.origin = config.get<string>('WEBAUTHN_ORIGIN', 'http://localhost:3000');
  }

  async generateRegistrationOptionsFor(
    tenantId: string,
    userId: string,
    userEmail: string,
  ): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }> {
    const existing = await this.credentials.findForUser(userId);
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userName: userEmail,
      userID: new TextEncoder().encode(userId),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    const challengeId = await this.challenges.create({ tenantId, userId, challenge: options.challenge });
    return { options, challengeId };
  }

  async verifyRegistration(
    tenantId: string,
    userId: string,
    challengeId: string,
    response: RegistrationResponseJSON,
    deviceName: string | null,
  ): Promise<WebAuthnCredential> {
    const pending = await this.challenges.consume(challengeId);
    if (!pending || pending.userId !== userId || pending.tenantId !== tenantId) {
      throw new WebAuthnChallengeExpiredError();
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
      });
    } catch (err) {
      throw new WebAuthnVerificationFailedError((err as Error).message);
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new WebAuthnVerificationFailedError('registration response did not verify');
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    return this.credentials.save({
      tenantId,
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter,
      deviceType: credentialDeviceType as WebAuthnDeviceType,
      backedUp: credentialBackedUp,
      transports: credential.transports ?? [],
      deviceName,
      lastUsedAt: null,
    } as never);
  }

  /**
   * Returns `null` if the email has no account or no registered
   * credentials - the controller still returns a generically-shaped
   * response either way (same account-enumeration posture as
   * `PasswordAuthService.authenticate`).
   */
  async generateAuthenticationOptionsFor(
    tenantId: string,
    email: string,
  ): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string } | null> {
    const user = await this.usersRepository.findByEmail(email);
    if (!user) {
      return null;
    }
    const creds = await this.credentials.findForUser(user.id);
    if (creds.length === 0) {
      return null;
    }
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: creds.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
      userVerification: 'preferred',
    });
    const challengeId = await this.challenges.create({ tenantId, userId: user.id, challenge: options.challenge });
    return { options, challengeId };
  }

  /** On success, returns a `webauthn_session_token` for `POST /oauth/authorize` (see `WebAuthnSessionService`), plus the authenticated `userId` (for audit instrumentation - ADR-0044). */
  async verifyAuthentication(
    tenantId: string,
    challengeId: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ token: string; userId: string }> {
    await this.authMethodPolicy.assertMethodPermitted('webauthn');
    const pending = await this.challenges.consume(challengeId);
    if (!pending || pending.tenantId !== tenantId) {
      throw new WebAuthnChallengeExpiredError();
    }

    const stored = await this.credentials.findByCredentialId(response.id);
    if (!stored || stored.userId !== pending.userId) {
      throw new WebAuthnVerificationFailedError('unknown credential');
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        credential: {
          id: stored.credentialId,
          publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64')),
          counter: stored.counter,
          transports: stored.transports as AuthenticatorTransportFuture[],
        },
      });
    } catch (err) {
      throw new WebAuthnVerificationFailedError((err as Error).message);
    }
    if (!verification.verified) {
      throw new WebAuthnVerificationFailedError('authentication response did not verify');
    }

    // Clone-detection: a cloned authenticator's counter stalls or resets.
    // Authenticators that never increment (rare, counter permanently 0) are
    // exempted per the spec's own recommended handling.
    const { newCounter } = verification.authenticationInfo;
    if (newCounter !== 0 && newCounter <= stored.counter) {
      throw new WebAuthnVerificationFailedError('authenticator signature counter did not increase');
    }
    await this.credentials.updateCounter(stored.id, newCounter);

    const token = await this.webauthnSessions.issue({ tenantId, userId: pending.userId });
    return { token, userId: pending.userId };
  }
}
