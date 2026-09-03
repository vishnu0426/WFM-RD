/**
 * Partial override of expo-crypto for tests — ONLY `randomUUID`.
 * jest-expo's generic native-module auto-mock resolves `randomUUID()` to
 * `undefined` rather than throwing - a real, previously-latent bug this
 * exists to catch: an `undefined` id serializes inconsistently through
 * `JSON.stringify` (stays the string "undefined" in a template-literal
 * key, but becomes `null` inside an array), which silently corrupted
 * `ChunkedSecureStore`'s own index-vs-payload reconciliation and made a
 * freshly-queued action vanish on the very next `list()` call.
 *
 * `getRandomBytesAsync`/`digestStringAsync` (used by `src/auth/pkce.ts`)
 * are deliberately NOT overridden here - they already resolve to a usable
 * implementation under Jest (confirmed: Phase 2's `AuthContext.test.tsx`/
 * `tokenGateway.test.tsx` exercise `signIn()`'s real PKCE flow and pass),
 * so this stays a single, narrow, disclosed fix rather than a wholesale
 * module replacement that risks changing behavior nothing asked to change.
 */
import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function randomUUID(): string {
  return nodeRandomUUID();
}
