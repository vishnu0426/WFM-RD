import { IngestionService } from '../../src/ingestion/ingestion.service';
import { UpstreamUnavailableError } from '../../src/common/errors/upstream-unavailable.error';
import { IntradayRedisUnavailableError } from '../../src/redis/redis.service';
import { ActivityEventDto } from '../../src/ingestion/dto/activity-event.dto';

describe('IngestionService', () => {
  const TENANT_ID = 't-1';
  const event: ActivityEventDto = {
    sourceEventId: 'evt-1',
    employeeId: 'e-1',
    currentActivity: 'available',
    activityStartedAt: new Date().toISOString(),
  };

  const makeRedis = () => ({
    acquireIngestionIdempotencyLock: jest.fn().mockResolvedValue(true),
    releaseIngestionIdempotencyLock: jest.fn().mockResolvedValue(undefined),
  });
  const makeNats = () => ({ publish: jest.fn().mockResolvedValue(undefined) });
  const makeMetrics = () => ({
    recordIngestionEvent: jest.fn(),
    observeRedisOperation: jest.fn(),
    observeNatsPublish: jest.fn(),
  });
  const makeConfig = () => ({ get: jest.fn().mockReturnValue(86400) });

  it('publishes to the per-employee NATS subject and returns "accepted" on first sighting', async () => {
    const redis = makeRedis();
    const nats = makeNats();
    const service = new IngestionService(redis as never, nats as never, makeMetrics() as never, makeConfig() as never);

    const outcome = await service.ingest(TENANT_ID, event);

    expect(outcome).toBe('accepted');
    expect(redis.acquireIngestionIdempotencyLock).toHaveBeenCalledWith(TENANT_ID, event.sourceEventId, 86400);
    expect(nats.publish).toHaveBeenCalledTimes(1);
    expect(nats.publish.mock.calls[0][0]).toBe('agno.intraday.agent.state_changed.v1.e-1');
    expect(nats.publish.mock.calls[0][1]).toMatchObject({ tenantId: TENANT_ID, employeeId: 'e-1' });
  });

  it('returns "duplicate" without publishing when the idempotency lock is already held', async () => {
    const redis = makeRedis();
    redis.acquireIngestionIdempotencyLock.mockResolvedValue(false);
    const nats = makeNats();
    const service = new IngestionService(redis as never, nats as never, makeMetrics() as never, makeConfig() as never);

    const outcome = await service.ingest(TENANT_ID, event);

    expect(outcome).toBe('duplicate');
    expect(nats.publish).not.toHaveBeenCalled();
  });

  it('wraps a Redis failure during dedupe as UpstreamUnavailableError (fail-visible, ADR-0062)', async () => {
    const redis = makeRedis();
    redis.acquireIngestionIdempotencyLock.mockRejectedValue(
      new IntradayRedisUnavailableError('acquireIngestionIdempotencyLock', new Error('down')),
    );
    const service = new IngestionService(
      redis as never,
      makeNats() as never,
      makeMetrics() as never,
      makeConfig() as never,
    );

    await expect(service.ingest(TENANT_ID, event)).rejects.toThrow(UpstreamUnavailableError);
  });

  it('releases the idempotency lock and surfaces UpstreamUnavailableError when the NATS publish fails', async () => {
    const redis = makeRedis();
    const nats = { publish: jest.fn().mockRejectedValue(new Error('nats down')) };
    const service = new IngestionService(redis as never, nats as never, makeMetrics() as never, makeConfig() as never);

    await expect(service.ingest(TENANT_ID, event)).rejects.toThrow(UpstreamUnavailableError);
    // Without this, a legitimate ACD retry after the 503 would be silently
    // treated as a duplicate for the rest of the TTL window - see
    // IntradayRedisService.releaseIngestionIdempotencyLock's doc comment.
    expect(redis.releaseIngestionIdempotencyLock).toHaveBeenCalledWith(TENANT_ID, event.sourceEventId);
  });
});
