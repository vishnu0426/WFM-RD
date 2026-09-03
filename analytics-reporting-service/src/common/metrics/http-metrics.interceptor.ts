import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

type Transport = 'http' | 'graphql';

/**
 * Phase 4: multi-transport, mirroring adherence-compliance-service's own
 * upgrade - `context.switchToHttp().getRequest()` doesn't return a real
 * Express `Request` in a GraphQL context, exactly the real bug that
 * service's own Phase 2 doc comment records hitting on first live GraphQL
 * exercise. Phase 1's doc comment predicted this upgrade the instant a
 * GraphQL surface landed; it landed this phase.
 *
 * Route label uses Express's post-routing `req.route.path` for REST (the
 * path *template*, not the raw URL with a real id interpolated in) and
 * `<Type>.<field>` (e.g. `Mutation.createDashboard`) for GraphQL - both
 * bounded-cardinality label shapes, matching Prometheus's own best
 * practices.
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
