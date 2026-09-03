/**
 * ECMA-323 Annex J ("CSTA XML over TCP") message framing - a real,
 * normative, freely-published international standard (not Avaya's own
 * gated TSAPI SDK/Programmer's Guide). Every CSTA-XML instance message on
 * the wire is prefixed by a 2-byte header (`0x00 0x00` = a plain CSTA-XML
 * body, no SOAP; `0x01 0x00`/`0x00 0x01`-style SOAP variants are out of
 * scope here) and a 2-byte big-endian length (the *full* frame length,
 * prefix included), followed by a 4-byte ASCII decimal Invoke ID (used to
 * correlate a request with its response; `"9999"` is the value the
 * standard reserves for server-pushed CSTA events) and the XML body
 * itself, encoded as ASCII text.
 *
 * Verbatim port of `integration-hub-service/src/sync/relay/providers/csta-xml-frame.ts`
 * - this file has no framework dependency in either location, so the two
 * copies are byte-for-byte identical protocol logic. Kept as a real
 * duplicate rather than a shared package: this repo has no cross-service
 * shared-package convention (every service, including this standalone
 * collector, is fully independent - own `package.json`, own `node_modules`),
 * and the two copies serve genuinely different processes (our cloud
 * service vs. a customer-network-deployed collector) that must never
 * secretly depend on each other's deploy cadence.
 */

const HEADER_LENGTH = 2;
const LENGTH_FIELD_LENGTH = 2;
const FRAME_PREFIX_LENGTH = HEADER_LENGTH + LENGTH_FIELD_LENGTH;
const INVOKE_ID_LENGTH = 4;

/** The Invoke ID Annex J §J.2 reserves for unsolicited (server -> client) CSTA events, never used on a request this collector sends. */
export const CSTA_EVENT_INVOKE_ID = "9999";

export interface CstaFrame {
  invokeId: string;
  xml: string;
}

export function encodeCstaFrame(invokeId: string, xmlBody: string): Buffer {
  if (invokeId.length !== INVOKE_ID_LENGTH) {
    throw new Error(
      `CSTA Invoke ID must be exactly ${INVOKE_ID_LENGTH} ASCII characters, got "${invokeId}"`,
    );
  }
  const invokeBuf = Buffer.from(invokeId, "ascii");
  const xmlBuf = Buffer.from(xmlBody, "ascii");
  const totalLength = FRAME_PREFIX_LENGTH + invokeBuf.length + xmlBuf.length;
  const lengthBuf = Buffer.alloc(LENGTH_FIELD_LENGTH);
  lengthBuf.writeUInt16BE(totalLength, 0);
  return Buffer.concat([
    Buffer.from([0x00, 0x00]),
    lengthBuf,
    invokeBuf,
    xmlBuf,
  ]);
}

/** Zero-padded decimal Invoke ID generator for real service requests - wraps below 9999 so it never collides with the reserved event Invoke ID. */
export class CstaInvokeIdGenerator {
  private next = 1;
  generate(): string {
    const id = String(this.next).padStart(INVOKE_ID_LENGTH, "0");
    this.next = this.next >= 9998 ? 1 : this.next + 1;
    return id;
  }
}

/**
 * Buffers arbitrary TCP chunk boundaries into complete, length-prefixed
 * frames - a single `Annex J` frame is not guaranteed to arrive in one
 * `data` event (or could arrive batched with others), so this is a real
 * incremental parser, not a per-chunk `JSON.parse`-style shortcut.
 */
export class CstaFrameReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): CstaFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: CstaFrame[] = [];
    for (;;) {
      if (this.buffer.length < FRAME_PREFIX_LENGTH) break;
      const totalLength = this.buffer.readUInt16BE(HEADER_LENGTH);
      if (this.buffer.length < totalLength) break;

      const isPlainCstaXml = this.buffer[0] === 0x00 && this.buffer[1] === 0x00;
      if (isPlainCstaXml) {
        const invokeId = this.buffer
          .subarray(FRAME_PREFIX_LENGTH, FRAME_PREFIX_LENGTH + INVOKE_ID_LENGTH)
          .toString("ascii");
        const xml = this.buffer
          .subarray(FRAME_PREFIX_LENGTH + INVOKE_ID_LENGTH, totalLength)
          .toString("ascii");
        frames.push({ invokeId, xml });
      }
      // A SOAP-enveloped frame (header `0x01`) is well-formed per the
      // standard but not a shape this collector speaks - dropped rather
      // than mis-decoded as plain CSTA-XML.
      this.buffer = this.buffer.subarray(totalLength);
    }
    return frames;
  }
}
