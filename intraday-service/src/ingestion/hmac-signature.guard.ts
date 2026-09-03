import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { InvalidSignatureError } from '../common/errors/invalid-signature.error';
import { IngestionCredentialsService } from '../ingestion-credentials/ingestion-credentials.service';

const SIGNATURE_HEADER = 'x-agno-webhook-signature';
const SIGNATURE_PATTERN = /^t=(\d+),v1=([0-9a-f]+)$/;

/**
 * Verifies the `t=<unix_ms>,v1=<hmac>` shape ADR-0046 already established
 * for this platform's *outbound* webhook signing, in reverse: recomputes
 * `HMAC-SHA256(secret, "${timestamp}.${rawBody}")` and compares with
 * `timingSafeEqual` (same idiom as `PkceService.verify`). The timestamp
 * check rejects a captured-and-replayed request outside the tolerance
 * window - a body-only HMAC couldn't express that.
 *
 * Secret resolution goes through `IngestionCredentialsService.listActiveSecrets` -
 * a real per-tenant, Vault-backed store, not the `INTRADAY_WEBHOOK_SECRETS`
 * env-var map this guard used through Phase 2 (that doc comment always
 * named this replacement "no later than Phase 3"). A tenant mid-rotation
 * can hold two active credentials at once; this tries each until one's
 * secret matches, so rotating never has a hard cutover moment.
 */
@Injectable()
export class HmacSignatureGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly credentials: IngestionCredentialsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    const toleranceSeconds = this.config.get<number>('INTRADAY_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS', 300);
    if (Math.abs(Date.now() - Number(timestampRaw)) > toleranceSeconds * 1000) {
      throw new InvalidSignatureError('timestamp outside the tolerance window (stale request or replay)');
    }

    const rawBody = (request.rawBody ?? Buffer.alloc(0)).toString('utf8');
    const provided = Buffer.from(providedSignatureHex, 'utf8');

    const secrets = await this.credentials.listActiveSecrets(tenantId);
    if (secrets.length === 0) {
      throw new InvalidSignatureError(`no active ingestion credential configured for tenant ${tenantId}`);
    }

    const matches = secrets.some((secret) => {
      const expectedHex = createHmac('sha256', secret).update(`${timestampRaw}.${rawBody}`).digest('hex');
      const expected = Buffer.from(expectedHex, 'utf8');
      return expected.length === provided.length && timingSafeEqual(expected, provided);
    });
    if (!matches) {
      throw new InvalidSignatureError('HMAC does not match any active ingestion credential for this tenant');
    }
    return true;
  }
}
