import * as Crypto from 'expo-crypto';

/** 32 random bytes -> 43 base64url chars, RFC 7636's minimum verifier length. */
const CODE_VERIFIER_BYTE_LENGTH = 32;

const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function bytesToBase64Url(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += BASE64URL_CHARS[(chunk >> 18) & 63];
    result += BASE64URL_CHARS[(chunk >> 12) & 63];
    result += BASE64URL_CHARS[(chunk >> 6) & 63];
    result += BASE64URL_CHARS[chunk & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = bytes[i] << 16;
    result += BASE64URL_CHARS[(chunk >> 18) & 63];
    result += BASE64URL_CHARS[(chunk >> 12) & 63];
  } else if (remaining === 2) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result += BASE64URL_CHARS[(chunk >> 18) & 63];
    result += BASE64URL_CHARS[(chunk >> 12) & 63];
    result += BASE64URL_CHARS[(chunk >> 6) & 63];
  }
  return result;
}

function base64ToBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Matches `^[A-Za-z0-9\-._~]{43,128}$` (RFC 7636 §4.1), verified against
 * the server's own `PkceService.assertValidVerifierFormat`. */
export async function generateCodeVerifier(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(CODE_VERIFIER_BYTE_LENGTH);
  return bytesToBase64Url(bytes);
}

/** S256 only — the server rejects `plain` outright (docs/adr/0026-adjacent
 * `pkce.service.ts`: `assertSupportedMethod` + a DB CHECK constraint). */
export async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const digestBase64 = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    codeVerifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  return base64ToBase64Url(digestBase64);
}
