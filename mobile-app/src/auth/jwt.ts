/**
 * Payload-only decode of the access token, no signature verification — the
 * app received this token directly from a trusted TLS token endpoint
 * (`POST /oauth/token`); verifying signatures is the resource server's job,
 * not a public OAuth client's (docs/adr/0150).
 */
export interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  tenant_id: string;
  org_unit_id: string | null;
  roles: string[];
  permissions: string[];
  amr: string[];
  jti: string;
  exp: number;
  iat: number;
}

const BASE64URL_LOOKUP: Record<string, number> = {};
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  .split('')
  .forEach((char, index) => {
    BASE64URL_LOOKUP[char] = index;
  });

function base64UrlToBytes(base64url: string): Uint8Array {
  const chars = base64url.replace(/=+$/, '').split('');
  const bytes: number[] = [];
  for (let i = 0; i + 1 < chars.length; i += 4) {
    const c0 = BASE64URL_LOOKUP[chars[i]] ?? 0;
    const c1 = BASE64URL_LOOKUP[chars[i + 1]] ?? 0;
    const c2 = chars[i + 2] !== undefined ? BASE64URL_LOOKUP[chars[i + 2]] : undefined;
    const c3 = chars[i + 3] !== undefined ? BASE64URL_LOOKUP[chars[i + 3]] : undefined;

    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 !== undefined) bytes.push(((c1 & 0xf) << 4) | (c2 >> 2));
    if (c3 !== undefined) bytes.push(((c2! & 0x3) << 6) | c3);
  }
  return Uint8Array.from(bytes);
}

/** Minimal UTF-8 byte decoder — avoids depending on a global `TextDecoder`
 * that isn't guaranteed present in every RN JS engine/test environment. */
function utf8BytesToString(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  while (i < bytes.length) {
    const byte1 = bytes[i];
    if (byte1 < 0x80) {
      result += String.fromCharCode(byte1);
      i += 1;
    } else if (byte1 >> 5 === 0x6) {
      const byte2 = bytes[i + 1];
      result += String.fromCharCode(((byte1 & 0x1f) << 6) | (byte2 & 0x3f));
      i += 2;
    } else if (byte1 >> 4 === 0xe) {
      const byte2 = bytes[i + 1];
      const byte3 = bytes[i + 2];
      result += String.fromCharCode(
        ((byte1 & 0xf) << 12) | ((byte2 & 0x3f) << 6) | (byte3 & 0x3f),
      );
      i += 3;
    } else {
      const byte2 = bytes[i + 1];
      const byte3 = bytes[i + 2];
      const byte4 = bytes[i + 3];
      const codePoint =
        ((byte1 & 0x7) << 18) | ((byte2 & 0x3f) << 12) | ((byte3 & 0x3f) << 6) | (byte4 & 0x3f);
      result += String.fromCodePoint(codePoint);
      i += 4;
    }
  }
  return result;
}

export function decodeAccessTokenClaims(accessToken: string): AccessTokenClaims {
  const [, payloadSegment] = accessToken.split('.');
  if (!payloadSegment) {
    throw new Error('Access token is not a well-formed JWT.');
  }
  const json = utf8BytesToString(base64UrlToBytes(payloadSegment));
  return JSON.parse(json) as AccessTokenClaims;
}
