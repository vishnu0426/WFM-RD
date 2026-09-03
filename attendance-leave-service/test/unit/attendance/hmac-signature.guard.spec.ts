import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { HmacSignatureGuard } from '../../../src/attendance/hmac-signature.guard';
import { InvalidSignatureError } from '../../../src/common/errors/invalid-signature.error';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const SECRET = 'dev-secret-tenant-1';

function contextWith(headers: Record<string, string>, rawBody = '{}'): ExecutionContext {
  const request = { headers, params: { tenantId: TENANT_ID }, rawBody: Buffer.from(rawBody) };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function sign(timestamp: number, rawBody: string, secret = SECRET): string {
  const hex = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${hex}`;
}

describe('HmacSignatureGuard', () => {
  let config: ConfigService;
  let guard: HmacSignatureGuard;

  beforeEach(() => {
    config = new ConfigService({
      ATTENDANCE_WEBHOOK_SECRETS: JSON.stringify({ [TENANT_ID]: SECRET }),
      ATTENDANCE_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: 300,
    });
    guard = new HmacSignatureGuard(config);
  });

  it('accepts a validly signed request', () => {
    const rawBody = '{"employeeId":"emp-1"}';
    const signature = sign(Date.now(), rawBody);
    expect(guard.canActivate(contextWith({ 'x-agno-webhook-signature': signature }, rawBody))).toBe(true);
  });

  it('rejects a missing signature header', () => {
    expect(() => guard.canActivate(contextWith({}))).toThrow(InvalidSignatureError);
  });

  it('rejects a malformed signature header', () => {
    expect(() => guard.canActivate(contextWith({ 'x-agno-webhook-signature': 'not-the-right-shape' }))).toThrow(
      InvalidSignatureError,
    );
  });

  it('rejects a stale timestamp outside the tolerance window', () => {
    const rawBody = '{}';
    const staleTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago, tolerance is 5
    const signature = sign(staleTimestamp, rawBody);
    expect(() => guard.canActivate(contextWith({ 'x-agno-webhook-signature': signature }, rawBody))).toThrow(
      InvalidSignatureError,
    );
  });

  it('rejects when no secret is configured for the tenant', () => {
    const emptyConfig = new ConfigService({ ATTENDANCE_WEBHOOK_SECRETS: '{}' });
    const guardWithNoSecrets = new HmacSignatureGuard(emptyConfig);
    const rawBody = '{}';
    const signature = sign(Date.now(), rawBody);
    expect(() =>
      guardWithNoSecrets.canActivate(contextWith({ 'x-agno-webhook-signature': signature }, rawBody)),
    ).toThrow(InvalidSignatureError);
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const signedBody = '{"employeeId":"emp-1"}';
    const tamperedBody = '{"employeeId":"emp-2"}';
    const signature = sign(Date.now(), signedBody);
    expect(() => guard.canActivate(contextWith({ 'x-agno-webhook-signature': signature }, tamperedBody))).toThrow(
      InvalidSignatureError,
    );
  });

  it('rejects a signature produced with the wrong secret', () => {
    const rawBody = '{}';
    const signature = sign(Date.now(), rawBody, 'wrong-secret');
    expect(() => guard.canActivate(contextWith({ 'x-agno-webhook-signature': signature }, rawBody))).toThrow(
      InvalidSignatureError,
    );
  });
});
