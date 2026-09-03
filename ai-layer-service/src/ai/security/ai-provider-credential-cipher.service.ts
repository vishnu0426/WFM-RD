import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;

/**
 * A tenant's own bring-your-own-key credential (`AiProviderConfig.encryptedApiKey`)
 * is a real secret, not an ordinary config value - stored encrypted at rest,
 * never in plaintext, and never returned by any query (the `oauth_clients`
 * signing-secret precedent: write-only after creation, ADR-0046). AES-256-GCM
 * with a random 12-byte IV per encryption call, key from
 * `AI_PROVIDER_CREDENTIAL_ENCRYPTION_KEY` (32 raw bytes, hex-encoded in
 * config) - real encryption, not a placeholder.
 *
 * What this deliberately does NOT solve: key rotation and KMS-backed key
 * storage. The encryption key itself is a single static env var, the same
 * "local-dev-appropriate, disclosed production gap" posture this platform
 * already takes for e.g. `changeme_local_only` passwords - a real
 * production deployment needs this key sourced from a KMS/secrets manager
 * with rotation, not a static env var. Flagged explicitly in the readiness
 * checklist (docs/adr/0117), not silently left as if this were finished.
 */
@Injectable()
export class AiProviderCredentialCipherService {
  constructor(private readonly config: ConfigService) {}

  private getKey(): Buffer {
    const hex = this.config.getOrThrow<string>('AI_PROVIDER_CREDENTIAL_ENCRYPTION_KEY');
    const key = Buffer.from(hex, 'hex');
    if (key.length !== 32) {
      throw new Error(
        `AI_PROVIDER_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}) - generate one with e.g. "openssl rand -hex 32".`,
      );
    }
    return key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
  }

  decrypt(encoded: string): string {
    const raw = Buffer.from(encoded, 'base64');
    const iv = raw.subarray(0, IV_LENGTH_BYTES);
    const authTag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + 16);
    const ciphertext = raw.subarray(IV_LENGTH_BYTES + 16);
    const decipher = createDecipheriv(ALGORITHM, this.getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
