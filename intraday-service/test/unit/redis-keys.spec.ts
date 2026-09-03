import {
  agentLiveStateKey,
  ingestionIdempotencyKey,
  parseTrackedEmployeeKey,
  queueLiveStateKey,
  trackedEmployeeKey,
  TRACKED_EMPLOYEE_SCAN_PATTERN,
} from '../../src/redis/keys';

describe('Redis key builders (§2.1)', () => {
  it('builds the AgentLiveState key', () => {
    expect(agentLiveStateKey('t1', 'e1')).toBe('tenant:t1:agent:e1');
  });

  it('builds the QueueLiveState key', () => {
    expect(queueLiveStateKey('t1', 'q1')).toBe('tenant:t1:queue:q1');
  });

  it('builds the ingestion idempotency key, scoped by tenant and the source event id', () => {
    expect(ingestionIdempotencyKey('t1', 'evt-1')).toBe('tenant:t1:intraday:ingested-event:evt-1');
  });
});

describe('Tracked-employee key builders (Phase 2, §2.2 rule 2)', () => {
  it('builds the tracked-employee key', () => {
    expect(trackedEmployeeKey('t1', 'e1')).toBe('tenant:t1:intraday:tracked-employee:e1');
  });

  it('round-trips tenantId/employeeId back out of a key matching the SCAN pattern', () => {
    const key = trackedEmployeeKey('tenant-a', 'employee-b');
    expect(parseTrackedEmployeeKey(key)).toEqual({ tenantId: 'tenant-a', employeeId: 'employee-b' });
  });

  it('returns null for a key that does not match the tracked-employee shape', () => {
    expect(parseTrackedEmployeeKey('tenant:t1:agent:e1')).toBeNull();
  });

  it('the SCAN pattern actually matches what the key builder produces', () => {
    const key = trackedEmployeeKey('t1', 'e1');
    const regex = new RegExp('^' + TRACKED_EMPLOYEE_SCAN_PATTERN.split('*').map(escapeRegExp).join('.*') + '$');
    expect(regex.test(key)).toBe(true);
  });
});

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
