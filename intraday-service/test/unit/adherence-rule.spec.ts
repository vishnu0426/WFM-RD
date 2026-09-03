import { computeDeviationSeconds, isAdherent } from '../../src/adherence/adherence-rule';

describe('isAdherent (ADR-0067)', () => {
  it('is adherent when scheduled to be on shift', () => {
    expect(isAdherent('on_shift')).toBe(true);
  });

  it('is not adherent when known to be off shift (null)', () => {
    expect(isAdherent(null)).toBe(false);
  });

  it('is not adherent for any other value (no richer taxonomy exists to accept)', () => {
    expect(isAdherent('lunch')).toBe(false);
  });
});

describe('computeDeviationSeconds (ADR-0067)', () => {
  it('is 0 for a first-ever event (no previous event - benefit of the doubt)', () => {
    expect(computeDeviationSeconds(null, new Date('2026-08-07T10:00:00Z'))).toBe(0);
  });

  it('is 0 when the previous segment was adherent', () => {
    const previous = { scheduledActivity: 'on_shift', timestamp: new Date('2026-08-07T09:00:00Z') };
    expect(computeDeviationSeconds(previous, new Date('2026-08-07T10:00:00Z'))).toBe(0);
  });

  it('is the just-ended segment duration when it was non-adherent', () => {
    const previous = { scheduledActivity: null, timestamp: new Date('2026-08-07T09:00:00Z') };
    expect(computeDeviationSeconds(previous, new Date('2026-08-07T09:05:00Z'))).toBe(300);
  });

  it('is deterministic - built from stored timestamps, safe to recompute on redelivery', () => {
    const previous = { scheduledActivity: null, timestamp: new Date('2026-08-07T09:00:00Z') };
    const first = computeDeviationSeconds(previous, new Date('2026-08-07T09:05:00Z'));
    const second = computeDeviationSeconds(previous, new Date('2026-08-07T09:05:00Z'));
    expect(first).toBe(second);
  });

  it('never goes negative for an out-of-order timestamp', () => {
    const previous = { scheduledActivity: null, timestamp: new Date('2026-08-07T10:00:00Z') };
    expect(computeDeviationSeconds(previous, new Date('2026-08-07T09:59:00Z'))).toBe(0);
  });
});
