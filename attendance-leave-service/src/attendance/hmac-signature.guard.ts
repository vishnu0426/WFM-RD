import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { InvalidSignatureError } from '../common/errors/invalid-signature.error';
import { getNumberConfig } from '../common/config/get-number-config';

const SIGNATURE_HEADER = 'x-agno-webhook-signature';
const SIGNATURE_PATTERN = /^t=(\d+),v1=([0-9a-f]+)$/;

/**
 * Own copy of intraday-service's `HmacSignatureGuard` (ADR-0039 precedent).
 * Verifies the `t=<unix_ms>,v1=<hmac>` shape ADR-0046 established for this
 * platform's *outbound* webhook signing, in reverse:
 * `HMAC-SHA256(secret, "${timestamp}.${rawBody}")` compared with
 * `timingSafeEqual`.
 *
 * Secret resolution is this phase's explicit assumption (design doc,
 * mirroring Module 05 Phase 1's own assumption 1): a `tenantId -> secret`
 * map from `ATTENDANCE_WEBHOOK_SECRETS` env config, not a durable
 * per-tenant store.
 */
@Injectable()
export class HmacSignatureGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { rawBody?: Buffer; params: { tenantId: string } }>();
    const tenantId = request.params.tenantId;

    const header = request.headers[SIGNATURE_HEADER];
    if (!header || Array.isArray(header)) {
      throw new InvalidSignatureError(`missing or duplicated ${SIGNATURE_HEADER} header`);
    }
    const match = SIGNATURE_PATTERN.exec(header);
    if (!match) {
      throw new InvalidSignatureError(`malformed ${SIGNATURE_HEADER} header - expected "t=<unix_ms>,v1=<hex hmac>"`);
    }
    const [, timestampRaw, providedSignatureHex] = match;

    const toleranceSeconds = getNumberConfig(this.config, 'ATTENDANCE_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS', 300);
    if (Math.abs(Date.now() - Number(timestampRaw)) > toleranceSeconds * 1000) {
      throw new InvalidSignatureError('timestamp outside the tolerance window (stale request or replay)');
    }

    const secret = this.resolveSecret(tenantId);
    if (!secret) {
      throw new InvalidSignatureError(`no webhook secret configured for tenant ${tenantId}`);
    }

    const rawBody = (request.rawBody ?? Buffer.alloc(0)).toString('utf8');
    const expectedHex = createHmac('sha256', secret).update(`${timestampRaw}.${rawBody}`).digest('hex');
    const expected = Buffer.from(expectedHex, 'utf8');
    const provided = Buffer.from(providedSignatureHex, 'utf8');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new InvalidSignatureError('HMAC does not match');
    }
    return true;
  }

  private resolveSecret(tenantId: string): string | undefined {
    try {
      const secrets = JSON.parse(this.config.get<string>('ATTENDANCE_WEBHOOK_SECRETS', '{}')) as Record<string, string>;
      return secrets[tenantId];
    } catch {
      return undefined;
    }
  }
}
