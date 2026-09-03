import {
  CSTA_EVENT_INVOKE_ID,
  CstaFrameReader,
  CstaInvokeIdGenerator,
  encodeCstaFrame,
} from '../../../src/sync/relay/providers/csta-xml-frame';

/**
 * ECMA-323 Annex J's real, published framing (see `csta-xml-frame.ts`'s
 * own doc comment for the source) - this test builds frames by hand,
 * byte-by-byte, against the standard's own description rather than by
 * round-tripping through `encodeCstaFrame`, so a bug in encode and a
 * matching bug in decode can't cancel out.
 */
describe('CstaFrameReader / encodeCstaFrame (ECMA-323 Annex J)', () => {
  it('decodes a single complete frame delivered in one chunk', () => {
    const xml =
      '<MonitorStartResponse xmlns="http://www.ecma-international.org/standards/ecma-323/csta/ed6"><monitorCrossRefID>1</monitorCrossRefID></MonitorStartResponse>';
    const invokeId = '0001';
    const body = Buffer.concat([Buffer.from(invokeId, 'ascii'), Buffer.from(xml, 'ascii')]);
    const totalLength = 4 + body.length;
    const lengthBuf = Buffer.alloc(2);
    lengthBuf.writeUInt16BE(totalLength, 0);
    const frameBytes = Buffer.concat([Buffer.from([0x00, 0x00]), lengthBuf, body]);

    const reader = new CstaFrameReader();
    const frames = reader.push(frameBytes);

    expect(frames).toHaveLength(1);
    expect(frames[0].invokeId).toBe('0001');
    expect(frames[0].xml).toBe(xml);
  });

  it('reassembles a frame split across multiple TCP chunks', () => {
    const xml =
      '<AgentReadyEvent xmlns="http://www.ecma-international.org/standards/ecma-323/csta/ed6"><monitorCrossRefID>1</monitorCrossRefID><agentDevice><deviceIdentifier>4711</deviceIdentifier></agentDevice></AgentReadyEvent>';
    const frameBytes = encodeCstaFrame(CSTA_EVENT_INVOKE_ID, xml);

    const reader = new CstaFrameReader();
    const splitPoint = 5;
    const first = reader.push(frameBytes.subarray(0, splitPoint));
    expect(first).toHaveLength(0);
    const second = reader.push(frameBytes.subarray(splitPoint));

    expect(second).toHaveLength(1);
    expect(second[0].invokeId).toBe('9999');
    expect(second[0].xml).toBe(xml);
  });

  it('decodes two frames delivered back-to-back in a single chunk', () => {
    const frame1 = encodeCstaFrame('0001', '<A/>');
    const frame2 = encodeCstaFrame('0002', '<B/>');
    const reader = new CstaFrameReader();

    const frames = reader.push(Buffer.concat([frame1, frame2]));

    expect(frames.map((f) => f.invokeId)).toEqual(['0001', '0002']);
    expect(frames.map((f) => f.xml)).toEqual(['<A/>', '<B/>']);
  });

  it('drops a SOAP-enveloped frame (header 0x01) rather than mis-decoding it as plain CSTA-XML', () => {
    const xml = '<SOAP-ENV:Envelope/>';
    const body = Buffer.concat([Buffer.from('0001', 'ascii'), Buffer.from(xml, 'ascii')]);
    const totalLength = 4 + body.length;
    const lengthBuf = Buffer.alloc(2);
    lengthBuf.writeUInt16BE(totalLength, 0);
    const soapFrame = Buffer.concat([Buffer.from([0x01, 0x00]), lengthBuf, body]);
    const plainFrame = encodeCstaFrame('0002', '<Plain/>');

    const reader = new CstaFrameReader();
    const frames = reader.push(Buffer.concat([soapFrame, plainFrame]));

    expect(frames).toHaveLength(1);
    expect(frames[0].invokeId).toBe('0002');
  });

  it('rejects an Invoke ID that is not exactly 4 characters', () => {
    expect(() => encodeCstaFrame('1', '<A/>')).toThrow();
  });

  it('CstaInvokeIdGenerator produces zero-padded 4-digit IDs that never collide with the reserved event ID', () => {
    const gen = new CstaInvokeIdGenerator();
    const first = gen.generate();
    expect(first).toBe('0001');
    expect(first).toHaveLength(4);
    for (let i = 0; i < 20000; i++) {
      expect(gen.generate()).not.toBe(CSTA_EVENT_INVOKE_ID);
    }
  });
});
