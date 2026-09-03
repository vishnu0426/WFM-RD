import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { AiProviderCredentialCipherService } from '../../../../src/ai/security/ai-provider-credential-cipher.service';

describe('AiProviderCredentialCipherService', () => {
  const key = randomBytes(32).toString('hex');

  function build(overrideKey?: string): AiProviderCredentialCipherService {
    const config = { getOrThrow: () => overrideKey ?? key } as unknown as ConfigService;
    return new AiProviderCredentialCipherService(config);
  }

  it('round-trips a plaintext API key through encrypt/decrypt', () => {
    const cipher = build();
    const encrypted = cipher.encrypt('sk-test-abc123');
    expect(encrypted).not.toContain('sk-test-abc123');
    expect(cipher.decrypt(encrypted)).toBe('sk-test-abc123');
  });

  it('produces a different ciphertext for the same plaintext on each call (random IV)', () => {
    const cipher = build();
    const first = cipher.encrypt('sk-test-abc123');
    const second = cipher.encrypt('sk-test-abc123');
    expect(first).not.toBe(second);
  });

  it('throws when the configured encryption key is not exactly 32 bytes', () => {
    const cipher = build(Buffer.from('too-short').toString('hex'));
    expect(() => cipher.encrypt('sk-test-abc123')).toThrow(/32 bytes/);
  });

  it('fails to decrypt (auth tag mismatch) if the ciphertext was tampered with', () => {
    const cipher = build();
    const encrypted = cipher.encrypt('sk-test-abc123');
    const tampered = Buffer.from(encrypted, 'base64');
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => cipher.decrypt(tampered.toString('base64'))).toThrow();
  });
});
