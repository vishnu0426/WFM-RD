import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

/**
 * GraphQL-aware from day one (unlike attendance-leave-service's REST-only
 * copy, whose own doc comment flags this exact upgrade as a future
 * requirement) - this service's primary API is GraphQL (§3.1), so the
 * global `APP_INTERCEPTOR` must not assume every request is an Express
 * `Request`/`Response` pair. Mirrors intraday-service's own
 * `http-metrics.interceptor.ts`, this platform's only prior GraphQL+REST
 * mixed surface.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<GqlContextType>() === 'graphql') {
      return next.handle();
    }

    const start = process.hrtime.bigint();
    const request = context.switchToHttp().getRequest<Request & { route?: { path: string } }>();
    const route = request.route?.path ?? request.path ?? 'unknown';

    const record = (statusCode: number): void => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.observeHttpRequest(request.method, route, statusCode, durationSeconds);
    };

    return next.handle().pipe(
      tap({
        next: () => record(context.switchToHttp().getResponse<Response>().statusCode),
        error: (err: { status?: number }) => record(err?.status ?? 500),
      }),
    );
  }
}
