import { IntradayRedisService } from '../../src/redis/redis.service';

/**
 * Minimal in-memory fake of the ioredis subset `IntradayRedisService` uses
 * (`pipeline().hset/hdel/exec`, `hgetall`, `set(...NX)`, `del`, `ping`) -
 * enough to prove the §2.1 key/field round-trip and the idempotency lock's
 * acquire/release semantics without a live Redis, mirroring this repo's own
 * unit-test style (plain mocks, no live infra - see
 * `test/unit/idempotency.interceptor.spec.ts` in the root app).
 */
class FakeRedis {
  private readonly hashes = new Map<string, Record<string, string>>();
  private readonly strings = new Map<string, string>();
  private readonly sets = new Map<string, Set<string>>();
  pingShouldFail = false;

  pipeline() {
    const ops: Array<() => void> = [];
    const pipelineObj = {
      hset: (key: string, fields: Record<string, string>) => {
        ops.push(() => {
          const existing = this.hashes.get(key) ?? {};
          this.hashes.set(key, { ...existing, ...fields });
        });
        return pipelineObj;
      },
      hdel: (key: string, ...fields: string[]) => {
        ops.push(() => {
          const existing = this.hashes.get(key);
          if (existing) {
            for (const f of fields) delete existing[f];
          }
        });
        return pipelineObj;
      },
      sadd: (key: string, member: string) => {
        ops.push(() => {
          const existing = this.sets.get(key) ?? new Set<string>();
          existing.add(member);
          this.sets.set(key, existing);
        });
        return pipelineObj;
      },
      srem: (key: string, member: string) => {
        ops.push(() => {
          this.sets.get(key)?.delete(member);
        });
        return pipelineObj;
      },
      exec: async () => {
        for (const op of ops) op();
        return ops.map(() => [null, 'OK']) as [Error | null, unknown][];
      },
    };
    return pipelineObj;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.hashes.get(key) ?? {};
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async set(key: string, value: string, ...rest: unknown[]): Promise<'OK' | null> {
    const isNx = rest.some((arg) => typeof arg === 'string' && arg.toUpperCase() === 'NX');
    if (isNx && this.strings.has(key)) {
      return null;
    }
    this.strings.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<void> {
    this.strings.delete(key);
    this.hashes.delete(key);
  }

  async ping(): Promise<string> {
    if (this.pingShouldFail) {
      throw new Error('ECONNREFUSED');
    }
    return 'PONG';
  }

  /** Single-batch (no real pagination) - the test data sets here are tiny, so cursor '0' is returned immediately. */
  async scan(
    _cursor: string,
    _matchKeyword: 'MATCH',
    pattern: string,
    ..._rest: unknown[]
  ): Promise<[string, string[]]> {
    const regex = new RegExp('^' + pattern.split('*').map(this.escapeRegExp).join('.*') + '$');
    const matched = [...this.strings.keys()].filter((key) => regex.test(key));
    return ['0', matched];
  }

  private escapeRegExp(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

describe('IntradayRedisService (§2.1 key schema round-trip)', () => {
  it('writes and reads back an AgentLiveState hash, stamping last_updated_at', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    await service.writeAgentLiveState('t1', 'e1', {
      currentActivity: 'on_call',
      activityStartedAt: '2026-08-07T10:00:00.000Z',
      scheduledActivity: 'lunch',
      adherenceStatus: 'out_of_adherence',
      siteId: 's1',
      queueId: 'q1',
    });

    const record = await service.readAgentLiveState('t1', 'e1');
    expect(record).toMatchObject({
      currentActivity: 'on_call',
      scheduledActivity: 'lunch',
      adherenceStatus: 'out_of_adherence',
      siteId: 's1',
      queueId: 'q1',
    });
    expect(record?.lastUpdatedAt).toBeDefined();
  });

  it('returns null for a key that was never written', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    expect(await service.readAgentLiveState('t1', 'unknown')).toBeNull();
  });

  it('clears a field via HDEL, not a stale leftover, when a later write sets it to null (§2.2 rule 2 mid-shift change)', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    await service.writeAgentLiveState('t1', 'e1', {
      currentActivity: 'on_call',
      activityStartedAt: '2026-08-07T10:00:00.000Z',
      scheduledActivity: 'lunch',
      adherenceStatus: null,
      siteId: null,
      queueId: null,
    });
    await service.writeAgentLiveState('t1', 'e1', {
      currentActivity: 'available',
      activityStartedAt: '2026-08-07T10:15:00.000Z',
      scheduledActivity: null,
      adherenceStatus: null,
      siteId: null,
      queueId: null,
    });

    const record = await service.readAgentLiveState('t1', 'e1');
    expect(record?.scheduledActivity).toBeNull();
    expect(record?.currentActivity).toBe('available');
  });

  it('writes and reads back a QueueLiveState hash with numeric fields parsed back to numbers', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    await service.writeQueueLiveState('t1', 'q1', {
      currentVolume: 42,
      agentsAvailable: 5,
      agentsOnCall: 3,
      forecastedVolume: 40,
      serviceLevelCurrent: 0.81,
      serviceLevelTarget: 0.8,
    });

    const record = await service.readQueueLiveState('t1', 'q1');
    expect(record).toMatchObject({
      currentVolume: 42,
      agentsAvailable: 5,
      agentsOnCall: 3,
      forecastedVolume: 40,
      serviceLevelCurrent: 0.81,
      serviceLevelTarget: 0.8,
    });
  });

  it('acquireIngestionIdempotencyLock: true on first sighting, false on retry within the TTL', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    expect(await service.acquireIngestionIdempotencyLock('t1', 'evt-1', 86400)).toBe(true);
    expect(await service.acquireIngestionIdempotencyLock('t1', 'evt-1', 86400)).toBe(false);
  });

  it('releaseIngestionIdempotencyLock lets a subsequent acquire succeed again', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    await service.acquireIngestionIdempotencyLock('t1', 'evt-1', 86400);
    await service.releaseIngestionIdempotencyLock('t1', 'evt-1');
    expect(await service.acquireIngestionIdempotencyLock('t1', 'evt-1', 86400)).toBe(true);
  });

  it('ping() reports ok:false rather than throwing when the client errors (health/readiness path)', async () => {
    const client = new FakeRedis();
    client.pingShouldFail = true;
    const service = new IntradayRedisService(client as never);
    const result = await service.ping();
    expect(result.ok).toBe(false);
  });
});

describe('IntradayRedisService partial writes (Phase 2)', () => {
  it('writing only scheduledActivity leaves currentActivity (written by a different consumer) untouched', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    await service.writeAgentLiveState('t1', 'e1', {
      currentActivity: 'on_call',
      activityStartedAt: '2026-08-07T10:00:00.000Z',
      siteId: 's1',
      queueId: 'q1',
    });

    // ScheduledActivityService's write path - only ever touches this one field.
    await service.writeAgentLiveState('t1', 'e1', { scheduledActivity: 'on_shift' });

    const record = await service.readAgentLiveState('t1', 'e1');
    expect(record?.scheduledActivity).toBe('on_shift');
    expect(record?.currentActivity).toBe('on_call');
    expect(record?.siteId).toBe('s1');
    expect(record?.queueId).toBe('q1');
  });

  it('writing only currentActivity/etc. leaves a previously-set scheduledActivity untouched', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    await service.writeAgentLiveState('t1', 'e1', { scheduledActivity: 'on_shift' });

    // AgentStateChangedConsumerService's write path - never touches scheduledActivity.
    await service.writeAgentLiveState('t1', 'e1', {
      currentActivity: 'break',
      activityStartedAt: '2026-08-07T11:00:00.000Z',
      siteId: null,
      queueId: null,
    });

    const record = await service.readAgentLiveState('t1', 'e1');
    expect(record?.currentActivity).toBe('break');
    expect(record?.scheduledActivity).toBe('on_shift');
  });
});

describe('IntradayRedisService tracked-employee registry (Phase 2, §2.2 rule 2)', () => {
  it('trackEmployeeForScheduleSync is refresh-friendly - a second call for the same employee does not fail', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    await service.trackEmployeeForScheduleSync('t1', 'e1', 3600);
    await expect(service.trackEmployeeForScheduleSync('t1', 'e1', 3600)).resolves.toBeUndefined();
  });

  it('listTrackedEmployees returns every tracked employee, parsed back to tenantId/employeeId', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    await service.trackEmployeeForScheduleSync('t1', 'e1', 3600);
    await service.trackEmployeeForScheduleSync('t1', 'e2', 3600);
    await service.trackEmployeeForScheduleSync('t2', 'e3', 3600);

    const tracked = await service.listTrackedEmployees();
    expect(tracked).toEqual(
      expect.arrayContaining([
        { tenantId: 't1', employeeId: 'e1' },
        { tenantId: 't1', employeeId: 'e2' },
        { tenantId: 't2', employeeId: 'e3' },
      ]),
    );
    expect(tracked).toHaveLength(3);
  });

  it('listTrackedEmployees does not pick up unrelated keys (e.g. the idempotency lock)', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    await service.acquireIngestionIdempotencyLock('t1', 'evt-1', 86400);
    await service.trackEmployeeForScheduleSync('t1', 'e1', 3600);

    const tracked = await service.listTrackedEmployees();
    expect(tracked).toEqual([{ tenantId: 't1', employeeId: 'e1' }]);
  });
});

describe('IntradayRedisService queue-membership reverse index + tracked-queue registry (Phase 6)', () => {
  it('updateQueueMembership adds to the new queue and removes from the old one', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    await service.updateQueueMembership('t1', 'e1', null, 'q1');
    expect(await service.listQueueMembers('t1', 'q1')).toEqual(['e1']);

    await service.updateQueueMembership('t1', 'e1', 'q1', 'q2');
    expect(await service.listQueueMembers('t1', 'q1')).toEqual([]);
    expect(await service.listQueueMembers('t1', 'q2')).toEqual(['e1']);
  });

  it('updateQueueMembership is a no-op when the queue is unchanged', async () => {
    const client = new FakeRedis();
    const pipelineSpy = jest.spyOn(client, 'pipeline');
    const service = new IntradayRedisService(client as never);

    await service.updateQueueMembership('t1', 'e1', 'q1', 'q1');

    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('updateQueueMembership with previousQueueId null only adds, never removes', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    await service.updateQueueMembership('t1', 'e1', null, 'q1');
    expect(await service.listQueueMembers('t1', 'q1')).toEqual(['e1']);
  });

  it('listQueueMembers returns an empty array for a queue with no tracked members', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    expect(await service.listQueueMembers('t1', 'unknown')).toEqual([]);
  });

  it('trackQueueForReallocationScan + listTrackedQueues round-trip, scoped to one tenant', async () => {
    const service = new IntradayRedisService(new FakeRedis() as never);
    await service.trackQueueForReallocationScan('t1', 'q1', 600);
    await service.trackQueueForReallocationScan('t1', 'q2', 600);
    await service.trackQueueForReallocationScan('t2', 'q3', 600);

    expect(await service.listTrackedQueues('t1')).toEqual(expect.arrayContaining(['q1', 'q2']));
    expect(await service.listTrackedQueues('t1')).toHaveLength(2);
    expect(await service.listTrackedQueues('t2')).toEqual(['q3']);
  });
});
