import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { exportJWK, importSPKI, type JWK, type KeyLike } from 'jose';
import { SigningKeysRepository } from '../repositories/signing-keys.repository';
import { SigningKey } from '../entities/signing-key.entity';
import { SigningKeyStatus } from '../entities/signing-key-status.enum';

/** ADR-0024: how long a retired key still verifies tokens signed before rotation. */
export const RETIRED_KEY_GRACE_PERIOD_MS = 30 * 60 * 1000;

const ALGORITHM = 'RS256';

/**
 * ADR-0024: RSA keypair generation, storage, and rotation for JWS-signed
 * access/ID tokens. Bootstraps a key on first boot if none is active
 * (`onModuleInit`) so a fresh environment (`docker-compose up` + migrations)
 * can issue tokens without a separate manual provisioning step - the
 * production equivalent of this bootstrap is a one-time KMS/HSM key
 * generation done by infra tooling, not application code (see the readiness
 * checklist).
 */
@Injectable()
export class SigningKeyService implements OnModuleInit {
  private readonly logger = new Logger(SigningKeyService.name);

  constructor(private readonly signingKeysRepository: SigningKeysRepository) {}

  async onModuleInit(): Promise<void> {
    const active = await this.signingKeysRepository.findActive();
    if (!active) {
      this.logger.log('No active signing key found - bootstrapping one (local-dev/first-boot path).');
      await this.generateAndActivate();
    }
  }

  /** ADR-0024's rotation: generate a new key, retire the previous active one. Runbook-triggered, not automatic. */
  async rotate(): Promise<SigningKey> {
    const key = this.buildKey();
    const rotated = await this.signingKeysRepository.rotate(key);
    this.logger.log(`Signing key rotated - new active kid=${rotated.kid}.`);
    return rotated;
  }

  private async generateAndActivate(): Promise<SigningKey> {
    const key = this.buildKey();
    return this.signingKeysRepository.save(key);
  }

  private buildKey(): SigningKey {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const key = new SigningKey();
    key.kid = randomUUID();
    key.algorithm = ALGORITHM;
    key.publicKeyPem = publicKey;
    key.privateKeyPem = privateKey;
    key.status = SigningKeyStatus.ACTIVE;
    key.retiredAt = null;
    return key;
  }

  async getActiveSigningMaterial(): Promise<{ kid: string; algorithm: string; privateKeyPem: string }> {
    const active = await this.signingKeysRepository.findActive();
    if (!active) {
      throw new Error('No active signing key - SigningKeyService failed to bootstrap one.');
    }
    return { kid: active.kid, algorithm: active.algorithm, privateKeyPem: active.privateKeyPem };
  }

  /** Verifier lookup by `kid`, restricted to keys still inside the verification grace window (ADR-0024). */
  async resolveVerificationKey(kid: string): Promise<KeyLike | null> {
    const key = await this.signingKeysRepository.findByKid(kid);
    if (!key) {
      return null;
    }
    const isActive = key.status === SigningKeyStatus.ACTIVE;
    const isRecentlyRetired =
      key.status === SigningKeyStatus.RETIRED &&
      key.retiredAt !== null &&
      Date.now() - key.retiredAt.getTime() < RETIRED_KEY_GRACE_PERIOD_MS;
    if (!isActive && !isRecentlyRetired) {
      return null;
    }
    return importSPKI(key.publicKeyPem, key.algorithm) as Promise<KeyLike>;
  }

  /** `GET /.well-known/jwks.json` (§5.6). */
  async getJwks(): Promise<{ keys: JWK[] }> {
    const cutoff = new Date(Date.now() - RETIRED_KEY_GRACE_PERIOD_MS);
    const verifiable = await this.signingKeysRepository.findVerifiable(cutoff);
    const jwks = await Promise.all(
      verifiable.map(async (key) => {
        const publicKey = await importSPKI(key.publicKeyPem, key.algorithm);
        const jwk = await exportJWK(publicKey);
        return { ...jwk, kid: key.kid, alg: key.algorithm, use: 'sig' };
      }),
    );
    return { keys: jwks };
  }
}
