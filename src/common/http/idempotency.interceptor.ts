import { CallHandler, ConflictException, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RedisService } from '../redis/redis.service';
import { TenantContextService } from '../tenant/tenant-context.service';

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const RESPONSE_CACHE_TTL_SECONDS = 24 * 60 * 60;
// In-flight marker only - cleared as soon as the handler finishes (success
// or error) via the tap/catchError below. This ceiling just bounds how long
// a genuinely-stuck request (crashed mid-handler, never reached either
// branch) blocks a retry with the same key.
const IN_FLIGHT_LOCK_TTL_SECONDS = 30;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface CachedResponse {
  status: number;
  body: unknown;
}

/**
 * §3.2's cross-cutting `Idempotency-Key` requirement (deferred by every
 * earlier phase - see ADR-0025's/ADR-0020's own "Phase 6" forward
 * references). Opt-in, not mandatory: a request without the header behaves
 * exactly as before. A request that *does* carry one, replayed with the
 * same key within 24h, gets the original response replayed verbatim instead
 * of re-executing the handler - the standard Stripe-style contract.
 *
 * Registered as a global `APP_INTERCEPTOR` (`app.module.ts`) but only acts
 * on plain HTTP POST/PUT/PATCH/DELETE requests - `/oauth/*` already has its
 * own idempotency-adjacent semantics per RFC (PKCE single-use codes, refresh
 * rotation) and is deliberately left alone rather than double-covered; SCIM/
 * webhook delivery already have their own dedup posture. GraphQL mutations
 * are not covered (no per-field HTTP semantics to hang a header off of -
 * see the Phase 6 design doc's explicit assumptions).
 *
 * Concurrent duplicate requests (the client fired the same key twice before
 * the first one finished) are rejected with 409, not silently serialized -
 * `RedisService.setIfNotExists` is the atomic "did I win the race" check.
 * On a Redis outage, `setIfNotExists` fails open (§1) - dedup/locking is
 * best-effort, never a hard dependency for the request to succeed at all.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly redis: RedisService,
    private readonly tenantContext: TenantContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> | Promise<Observable<unknown>> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<Request>();
    if (!MUTATING_METHODS.has(request.method)) {
      return next.handle();
    }
    const key = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (!key || Array.isArray(key)) {
      return next.handle();
    }

    // Returned directly (not wrapped in `from()`) - Nest's interceptor
    // pipeline natively supports `Promise<Observable<any>>` and awaits it
    // itself. Wrapping a *rejecting* promise in `from()` instead creates an
    // Observable nobody has subscribed to yet, which turns the rejection
    // into an unhandled promise rejection rather than a caught HTTP error.
    return this.handleIdempotent(context, next, key);
  }

  private async handleIdempotent(
    context: ExecutionContext,
    next: CallHandler,
    key: string,
  ): Promise<Observable<unknown>> {
    const tenantId = this.tenantContext.getStore()?.tenantId ?? 'unscoped';
    const cacheKey = `idempotency:${tenantId}:${key}`;
    const lockKey = `${cacheKey}:lock`;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const { status, body } = JSON.parse(cached) as CachedResponse;
      context.switchToHttp().getResponse<Response>().status(status);
      return of(body);
    }

    const acquired = await this.redis.setIfNotExists(lockKey, '1', IN_FLIGHT_LOCK_TTL_SECONDS);
    if (!acquired) {
      throw new ConflictException(
        `A request with Idempotency-Key '${key}' is already in progress - retry once it completes.`,
      );
    }

    // RedisService's own methods (`setWithTtl`/`del`) fail open and never
    // reject (§1 - see that class's doc comment), so these tap callbacks
    // don't need their own try/catch: worst case, the dedup cache simply
    // doesn't get written/cleared, which the next request's `setIfNotExists`
    // TTL expiry already tolerates.
    return next.handle().pipe(
      tap({
        next: (body) => {
          const response = context.switchToHttp().getResponse<Response>();
          const cached: CachedResponse = { status: response.statusCode, body };
          void this.redis.setWithTtl(cacheKey, JSON.stringify(cached), RESPONSE_CACHE_TTL_SECONDS);
          void this.redis.del(lockKey);
        },
        error: () => {
          void this.redis.del(lockKey);
        },
      }),
    );
  }
}
