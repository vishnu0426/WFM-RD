import { ConflictException, ExecutionContext, CallHandler } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { IdempotencyInterceptor } from '../../src/common/http/idempotency.interceptor';

describe('IdempotencyInterceptor', () => {
  const makeRedis = () => ({
    get: jest.fn().mockResolvedValue(null),
    setWithTtl: jest.fn().mockResolvedValue(undefined),
    setIfNotExists: jest.fn().mockResolvedValue(true),
    del: jest.fn().mockResolvedValue(undefined),
  });
  const makeTenantContext = () => ({ getStore: jest.fn().mockReturnValue({ tenantId: 'tenant-1' }) });

  const makeContext = (method: string, headers: Record<string, string> = {}, type: 'http' | 'graphql' = 'http') => {
    const response: { statusCode: number; status: (code: number) => void } = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
      },
    };
    const request = { method, headers };
    return {
      getType: () => type,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
  };

  const makeNext = (result: unknown = { ok: true }): CallHandler => ({
    handle: jest.fn().mockReturnValue(of(result)),
  });

  it('passes through non-HTTP (GraphQL) contexts untouched', async () => {
    const redis = makeRedis();
    const interceptor = new IdempotencyInterceptor(redis as never, makeTenantContext() as never);
    const next = makeNext();

    await firstValueFrom(await interceptor.intercept(makeContext('POST', {}, 'graphql'), next));
    expect(next.handle).toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('passes through GET requests untouched, even with an Idempotency-Key header', async () => {
    const redis = makeRedis();
    const interceptor = new IdempotencyInterceptor(redis as never, makeTenantContext() as never);
    const next = makeNext();

    await firstValueFrom(await interceptor.intercept(makeContext('GET', { 'idempotency-key': 'k1' }), next));
    expect(next.handle).toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('passes through a mutating request with no Idempotency-Key header', async () => {
    const redis = makeRedis();
    const interceptor = new IdempotencyInterceptor(redis as never, makeTenantContext() as never);
    const next = makeNext();

    await firstValueFrom(await interceptor.intercept(makeContext('POST', {}), next));
    expect(next.handle).toHaveBeenCalled();
    expect(redis.setIfNotExists).not.toHaveBeenCalled();
  });

  it('replays a cached response instead of re-executing the handler', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(JSON.stringify({ status: 201, body: { id: 'cached' } }));
    const interceptor = new IdempotencyInterceptor(redis as never, makeTenantContext() as never);
    const next = makeNext();

    const result = await firstValueFrom(
      await interceptor.intercept(makeContext('POST', { 'idempotency-key': 'k1' }), next),
    );
    expect(result).toEqual({ id: 'cached' });
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('rejects a concurrent duplicate with 409 when the in-flight lock is already held', async () => {
    const redis = makeRedis();
    redis.setIfNotExists.mockResolvedValue(false);
    const interceptor = new IdempotencyInterceptor(redis as never, makeTenantContext() as never);
    const next = makeNext();

    await expect(interceptor.intercept(makeContext('POST', { 'idempotency-key': 'k1' }), next)).rejects.toThrow(
      ConflictException,
    );
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('executes the handler, caches the response, and clears the lock on success', async () => {
    const redis = makeRedis();
    const interceptor = new IdempotencyInterceptor(redis as never, makeTenantContext() as never);
    const next = makeNext({ id: 'created-1' });

    const result = await firstValueFrom(
      await interceptor.intercept(makeContext('POST', { 'idempotency-key': 'k1' }), next),
    );
    expect(result).toEqual({ id: 'created-1' });
    expect(next.handle).toHaveBeenCalled();
    expect(redis.setWithTtl).toHaveBeenCalledWith(
      'idempotency:tenant-1:k1',
      JSON.stringify({ status: 200, body: { id: 'created-1' } }),
      24 * 60 * 60,
    );
    expect(redis.del).toHaveBeenCalledWith('idempotency:tenant-1:k1:lock');
  });
});
