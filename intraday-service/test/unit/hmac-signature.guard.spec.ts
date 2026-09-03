import { ExecutionContext } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { HmacSignatureGuard } from '../../src/ingestion/hmac-signature.guard';
import { InvalidSignatureError } from '../../src/common/errors/invalid-signature.error';

describe('HmacSignatureGuard', () => {
  const TENANT_ID = '11111111-1111-1111-1111-111111111111';
  const SECRET = 'dev-secret';

  const makeConfig = (overrides: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = {
      INTRADAY_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: 300,
      ...overrides,
    };
    return { get: jest.fn((key: string, def?: unknown) => (key in values ? values[key] : def)) };
  };

  const makeCredentials = (secrets: string[] = [SECRET]) => ({
    listActiveSecrets: jest.fn().mockResolvedValue(secrets),
  });

  const sign = (timestamp: number, rawBody: string, secret = SECRET): string =>
    createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

  const makeContext = (headers: Record<string, string>, rawBody: string, tenantId = TENANT_ID): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers, params: { tenantId }, rawBody: Buffer.from(rawBody, 'utf8') }),
      }),
    }) as unknown as ExecutionContext;

  it('accepts a correctly signed, fresh request', async () => {
    const rawBody = JSON.stringify({ sourceEventId: 'evt-1' });
    const timestamp = Date.now();
    const signature = sign(timestamp, rawBody);
    const guard = new HmacSignatureGuard(makeConfig() as never, makeCredentials() as never);

    await expect(
      guard.canActivate(makeContext({ 'x-agno-webhook-signature': `t=${timestamp},v1=${signature}` }, rawBody)),
    ).resolves.toBe(true);
  });

  it('rejects a missing signature header', async () => {
    const guard = new HmacSignatureGuard(makeConfig() as never, makeCredentials() as never);
    await expect(guard.canActivate(makeContext({}, '{}'))).rejects.toThrow(InvalidSignatureError);
  });

  it('rejects a malformed signature header', async () => {
    const guard = new HmacSignatureGuard(makeConfig() as never, makeCredentials() as never);
    await expect(
      guard.canActivate(makeContext({ 'x-agno-webhook-signature': 'not-the-right-shape' }, '{}')),
    ).rejects.toThrow(InvalidSignatureError);
  });

  it('rejects a timestamp outside the tolerance window (stale/replay)', async () => {
    const rawBody = '{}';
    const staleTimestamp = Date.now() - 10 * 60 * 1000; // 10 min old, tolerance is 5 min
    const signature = sign(staleTimestamp, rawBody);
    const guard = new HmacSignatureGuard(makeConfig() as never, makeCredentials() as never);
    await expect(
      guard.canActivate(makeContext({ 'x-agno-webhook-signature': `t=${staleTimestamp},v1=${signature}` }, rawBody)),
    ).rejects.toThrow(InvalidSignatureError);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const rawBody = '{}';
    const timestamp = Date.now();
    const signature = sign(timestamp, rawBody, 'wrong-secret');
    const guard = new HmacSignatureGuard(makeConfig() as never, makeCredentials() as never);
    await expect(
      guard.canActivate(makeContext({ 'x-agno-webhook-signature': `t=${timestamp},v1=${signature}` }, rawBody)),
    ).rejects.toThrow(InvalidSignatureError);
  });

  it('rejects a request for a tenant with no active ingestion credential', async () => {
    const rawBody = '{}';
    const timestamp = Date.now();
    const signature = sign(timestamp, rawBody);
    const guard = new HmacSignatureGuard(makeConfig() as never, makeCredentials([]) as never);
    await expect(
      guard.canActivate(makeContext({ 'x-agno-webhook-signature': `t=${timestamp},v1=${signature}` }, rawBody)),
    ).rejects.toThrow(InvalidSignatureError);
  });

  it('rejects a body tampered with after signing', async () => {
    const timestamp = Date.now();
    const signature = sign(timestamp, '{"a":1}');
    const guard = new HmacSignatureGuard(makeConfig() as never, makeCredentials() as never);
    await expect(
      guard.canActivate(makeContext({ 'x-agno-webhook-signature': `t=${timestamp},v1=${signature}` }, '{"a":2}')),
    ).rejects.toThrow(InvalidSignatureError);
  });

  it('accepts a signature matching the second credential during rotation (two active secrets at once)', async () => {
    const rawBody = '{}';
    const timestamp = Date.now();
    const newSecret = 'new-secret-mid-rotation';
    const signature = sign(timestamp, rawBody, newSecret);
    const guard = new HmacSignatureGuard(makeConfig() as never, makeCredentials([SECRET, newSecret]) as never);

    await expect(
      guard.canActivate(makeContext({ 'x-agno-webhook-signature': `t=${timestamp},v1=${signature}` }, rawBody)),
    ).resolves.toBe(true);
  });
});
