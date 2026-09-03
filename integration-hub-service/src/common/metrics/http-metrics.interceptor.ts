import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

type Transport = 'http' | 'graphql';

/**
 * Multi-transport from the start of Phase 2, since GraphQL (`createConnector`/
 * `connectors`) lands in the same phase as this interceptor's REST-only
 * Phase 1 version - own copy of intraday-service's fixed
 * `HttpMetricsInterceptor` (its own doc comment names the exact bug this
 * would otherwise reproduce: `context.switchToHttp().getRequest()` doesn't
 * return a real Express `Request` in a GraphQL context). Caught live by
 * this phase's own real end-to-end verification (a real `connectors` query
 * against the running app threw `Cannot read properties of undefined
 * (reading 'route')` before this fix), not by a unit test.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = process.hrtime.bigint();
    const transport = this.resolveTransport(context);
    const method = transport === 'graphql' ? 'GRAPHQL' : context.switchToHttp().getRequest<Request>().method;
    const route = this.resolveRoute(context, transport);

    const record = (statusCode: number): void => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.observeHttpRequest(method, route, statusCode, durationSeconds);
    };

    return next.handle().pipe(
      tap({
        next: () => record(transport === 'http' ? context.switchToHttp().getResponse<Response>().statusCode : 200),
        error: (err: { status?: number }) => record(err?.status ?? 500),
      }),
    );
  }

  private resolveTransport(context: ExecutionContext): Transport {
    return context.getType<GqlContextType>() === 'graphql' ? 'graphql' : 'http';
  }

  private resolveRoute(context: ExecutionContext, transport: Transport): string {
    if (transport === 'graphql') {
      const info = GqlExecutionContext.create(context).getInfo<{ parentType: { name: string }; fieldName: string }>();
      return `${info.parentType.name}.${info.fieldName}`;
    }
    const request = context.switchToHttp().getRequest<Request & { route?: { path: string } }>();
    return request.route?.path ?? request.path ?? 'unknown';
  }
}
