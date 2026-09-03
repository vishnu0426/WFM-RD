import { agentStateChangedSubject, INTRADAY_SUBJECTS } from '../../src/nats/subjects';

describe('NATS subjects (§4.3, ADR-0063)', () => {
  it('builds a per-employee-keyed subject for ordering', () => {
    expect(agentStateChangedSubject('e-1')).toBe('agno.intraday.agent.state_changed.v1.e-1');
  });

  it('uses the platform subject grammar for the other Module 05 subjects', () => {
    expect(INTRADAY_SUBJECTS.QUEUE_METRICS_UPDATED).toBe('agno.intraday.queue.metrics_updated.v1');
    expect(INTRADAY_SUBJECTS.REALLOCATION_SUGGESTED).toBe('agno.intraday.reallocation.suggested.v1');
    expect(INTRADAY_SUBJECTS.DLQ).toBe('agno.intraday.dlq.v1');
  });
});
