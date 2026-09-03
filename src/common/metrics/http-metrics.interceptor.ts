import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

type Transport = 'http' | 'graphql' | 'rpc';

/**
 * Phase 7 (ADR-0050): records `http_request_duration_seconds`/
 * `http_requests_total` for REST, GraphQL, *and* gRPC (`context.getType()
 * === 'rpc'`) calls - registered as a global `APP_INTERCEPTOR`
 * (`app.module.ts`, same shape as `IdempotencyInterceptor`, ADR-0047),
 * which wraps every transport's handlers uniformly, not just HTTP ones.
 * gRPC coverage matters here specifically because §0.5's "IdentityService.
 * ValidateToken/GetUserContext p99 < 50ms" SLO target - one of the panels
 * in `observability/grafana-dashboard.json` - is a gRPC method, not a REST
 * or GraphQL one; an interceptor that only understood `switchToHttp()`
 * would throw on every gRPC call (there is no Express `Request`/`Response`
 * in an `rpc` context) rather than silently under-counting it.
 *
 * The `route` label uses Express's post-routing `req.route.path` (the path
 * *template*, e.g. `/v1/roles/:id`, not the raw URL with a real id
 * interpolated in) for REST, `<Type>.<field>` (e.g. `Query.roles`) for
 * GraphQL, and `<Controller>.<handler>` for gRPC - all three are the
 * standard "bounded cardinality" label shape for a Prometheus histogram;
 * labeling by raw URL/query would create a new time series per unique id
 * ever requested, which is exactly the cardinality blowup Prometheus's own
 * best practices warn against.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = process.hrtime.bigint();
    const transport = this.resolveTransport(context);
    const method = this.resolveMethod(context, transport);
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
    const type = context.getType<GqlContextType | 'rpc'>();
    if (type === 'graphql') {
      return 'graphql';
    }
    if (type === 'rpc') {
      return 'rpc';
    }
    return 'http';
  }

  private resolveMethod(context: ExecutionContext, transport: Transport): string {
    if (transport === 'http') {
      return context.switchToHttp().getRequest<Request>().method;
    }
    if (transport === 'graphql') {
      return 'GRAPHQL';
    }
    return 'GRPC';
  }

  private resolveRoute(context: ExecutionContext, transport: Transport): string {
    if (transport === 'graphql') {
      const info = GqlExecutionContext.create(context).getInfo<{ parentType: { name: string }; fieldName: string }>();
      return `${info.parentType.name}.${info.fieldName}`;
    }
    if (transport === 'rpc') {
      return `${context.getClass().name}.${context.getHandler().name}`;
    }
    const request = context.switchToHttp().getRequest<Request & { route?: { path: string } }>();
    return request.route?.path ?? request.path ?? 'unknown';
  }
}
