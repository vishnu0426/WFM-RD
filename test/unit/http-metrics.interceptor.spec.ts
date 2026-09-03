import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { HttpMetricsInterceptor } from '../../src/common/metrics/http-metrics.interceptor';

describe('HttpMetricsInterceptor', () => {
  const makeMetrics = () => ({ observeHttpRequest: jest.fn() });
  const makeNext = (result: unknown = { ok: true }, error?: unknown): CallHandler => ({
    handle: jest.fn().mockReturnValue(error ? throwError(() => error) : of(result)),
  });

  it('records an HTTP request using the route template (req.route.path), not the raw URL', async () => {
    const metrics = makeMetrics();
    const interceptor = new HttpMetricsInterceptor(metrics as never);
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', route: { path: '/v1/roles/:id' }, path: '/v1/roles/abc-123' }),
        getResponse: () => ({ statusCode: 200 }),
      }),
    } as unknown as ExecutionContext;

    await new Promise<void>((resolve) => {
      interceptor.intercept(context, makeNext()).subscribe(() => resolve());
    });

    expect(metrics.observeHttpRequest).toHaveBeenCalledWith('GET', '/v1/roles/:id', 200, expect.any(Number));
  });

  it('records a GraphQL request using <ParentType>.<fieldName>', async () => {
    const metrics = makeMetrics();
    const interceptor = new HttpMetricsInterceptor(metrics as never);
    const context = {
      getType: () => 'graphql',
      getClass: () => ({ name: 'RoleResolver' }),
      getHandler: () => ({ name: 'roles' }),
      getArgs: () => [undefined, undefined, undefined, { parentType: { name: 'Query' }, fieldName: 'roles' }],
    } as unknown as ExecutionContext;

    await new Promise<void>((resolve) => {
      interceptor.intercept(context, makeNext()).subscribe(() => resolve());
    });

    expect(metrics.observeHttpRequest).toHaveBeenCalledWith('GRAPHQL', 'Query.roles', 200, expect.any(Number));
  });

  it('records a gRPC (rpc context) call without throwing - no switchToHttp() call is made', async () => {
    const metrics = makeMetrics();
    const interceptor = new HttpMetricsInterceptor(metrics as never);
    const switchToHttp = jest.fn();
    const context = {
      getType: () => 'rpc',
      getClass: () => ({ name: 'IdentityGrpcController' }),
      getHandler: () => ({ name: 'validateToken' }),
      switchToHttp,
    } as unknown as ExecutionContext;

    await new Promise<void>((resolve) => {
      interceptor.intercept(context, makeNext()).subscribe(() => resolve());
    });

    expect(switchToHttp).not.toHaveBeenCalled();
    expect(metrics.observeHttpRequest).toHaveBeenCalledWith(
      'GRPC',
      'IdentityGrpcController.validateToken',
      200,
      expect.any(Number),
    );
  });

  it('records the error status code (or 500 if none) when the handler throws', async () => {
    const metrics = makeMetrics();
    const interceptor = new HttpMetricsInterceptor(metrics as never);
    const context = {
      getType: () => 'rpc',
      getClass: () => ({ name: 'AuditGrpcController' }),
      getHandler: () => ({ name: 'recordEvent' }),
    } as unknown as ExecutionContext;

    await new Promise<void>((resolve) => {
      interceptor.intercept(context, makeNext(undefined, { status: 403 })).subscribe({
        error: () => resolve(),
      });
    });

    expect(metrics.observeHttpRequest).toHaveBeenCalledWith(
      'GRPC',
      'AuditGrpcController.recordEvent',
      403,
      expect.any(Number),
    );
  });
});
