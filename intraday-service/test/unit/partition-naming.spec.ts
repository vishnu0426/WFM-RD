import { addDays, partitionBounds, retentionCutoffPartitionName } from '../../src/adherence/partition-naming';

describe('partitionBounds', () => {
  it('builds the name and [start, end) bounds for a given date', () => {
    expect(partitionBounds(new Date('2026-08-07T15:30:00Z'))).toEqual({
      name: 'adherence_event_2026_08_07',
      start: '2026-08-07',
      end: '2026-08-08',
    });
  });

  it('rolls over a year boundary correctly', () => {
    expect(partitionBounds(new Date('2026-12-31T00:00:00Z'))).toEqual({
      name: 'adherence_event_2026_12_31',
      start: '2026-12-31',
      end: '2027-01-01',
    });
  });
});

describe('addDays', () => {
  it('adds and subtracts whole UTC days', () => {
    expect(addDays(new Date('2026-08-07T00:00:00Z'), 3).toISOString().slice(0, 10)).toBe('2026-08-10');
    expect(addDays(new Date('2026-08-07T00:00:00Z'), -3).toISOString().slice(0, 10)).toBe('2026-08-04');
  });
});

describe('retentionCutoffPartitionName', () => {
  it('names the partition covering (referenceDate - retentionDays)', () => {
    expect(retentionCutoffPartitionName(new Date('2026-08-07T00:00:00Z'), 1)).toBe('adherence_event_2026_08_06');
  });

  it('matches composing addDays + partitionBounds directly', () => {
    const referenceDate = new Date('2026-08-07T00:00:00Z');
    const expected = partitionBounds(addDays(referenceDate, -95)).name;
    expect(retentionCutoffPartitionName(referenceDate, 95)).toBe(expected);
  });
});
