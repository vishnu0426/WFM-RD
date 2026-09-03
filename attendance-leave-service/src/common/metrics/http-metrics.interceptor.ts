import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

/**
 * REST-only for this phase - unlike intraday-service's own copy, there is
 * no GraphQL surface yet to make `context.switchToHttp()` unsafe to call
 * unconditionally. intraday-service's own history is the explicit warning:
 * its first version broke the instant GraphQL requests started flowing
 * through this same global `APP_INTERCEPTOR`. Whichever future phase adds
 * GraphQL here must upgrade this the same way, branching on
 * `context.getType<GqlContextType>()` before assuming an Express request -
 * see that service's `http-metrics.interceptor.ts`.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
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
