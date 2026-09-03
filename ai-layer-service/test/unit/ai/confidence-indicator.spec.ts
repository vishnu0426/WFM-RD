import { computeConfidenceIndicator, computeGroundedness } from '../../../src/ai/confidence-indicator';

describe('computeGroundedness', () => {
  it('returns 1 when every numeric token in the output also appears in the input context', () => {
    const groundedness = computeGroundedness(
      'This schedule relaxed 2 constraints and cost 150.5 hours of overtime.',
      JSON.stringify({ relaxedCount: 2, overtimeHours: 150.5 }),
    );
    expect(groundedness).toBe(1);
  });

  it('returns a fraction when only some numeric tokens are traceable to the input context', () => {
    const groundedness = computeGroundedness(
      'This schedule relaxed 2 constraints and used 999 imaginary employees.',
      JSON.stringify({ relaxedCount: 2 }),
    );
    expect(groundedness).toBe(0.5);
  });

  it('returns 0 when no numeric tokens are traceable at all', () => {
    const groundedness = computeGroundedness('The schedule used 42 employees.', JSON.stringify({ unrelated: 'value' }));
    expect(groundedness).toBe(0);
  });

  it('returns a neutral 0.5 when the output text contains no numeric tokens to check', () => {
    const groundedness = computeGroundedness('This schedule looks reasonable overall.', JSON.stringify({ score: 5 }));
    expect(groundedness).toBe(0.5);
  });
});

describe('computeConfidenceIndicator', () => {
  it('averages self-reported confidence and groundedness, rounded to 2 decimals', () => {
    const result = computeConfidenceIndicator(0.9, 'Relaxed 2 constraints.', { relaxedCount: 2 });
    // groundedness = 1 (fully traceable), so (0.9 + 1) / 2 = 0.95
    expect(result).toBe(0.95);
  });

  it('clamps an out-of-range self-reported confidence into [0, 1] before combining', () => {
    const result = computeConfidenceIndicator(1.5, 'Relaxed 2 constraints.', { relaxedCount: 2 });
    expect(result).toBe(1);
  });

  it('clamps a negative self-reported confidence to 0', () => {
    const result = computeConfidenceIndicator(-0.5, 'no numbers here', {});
    // groundedness neutral 0.5 (no numeric tokens), clamped self-reported = 0 -> (0 + 0.5) / 2 = 0.25
    expect(result).toBe(0.25);
  });

  describe('Phase 9 (docs/adr/0131/0133) - untrusted free-text fields never count as grounding evidence', () => {
    it('does not credit a number that appears ONLY inside a "reason" field, even though it is technically present in the serialized inputContext', () => {
      const result = computeConfidenceIndicator(1.0, 'Reallocation for employee e-42 confirmed.', {
        affectedEmployeeIds: ['e-1'],
        reason: 'Reallocation for employee e-42 confirmed.',
      });
      // "42" only appears inside `reason` (redacted before comparison) - groundedness is 0, not 1.
      // (1.0 self-reported + 0 groundedness) / 2 = 0.5, not the 1.0 an unredacted comparison would give.
      expect(result).toBe(0.5);
    });

    it('does not credit a number that appears ONLY inside a "question" field (nl-query)', () => {
      const result = computeConfidenceIndicator(1.0, 'The answer involves 2026.', {
        question: 'What happened in 2026?',
        groundingData: { status: 'completed' },
      });
      expect(result).toBe(0.5);
    });

    it('still credits a number that independently appears in a genuinely trusted structured field, even if the untrusted "reason" field also happens to mention it', () => {
      const result = computeConfidenceIndicator(1.0, 'The objective score was 123.45.', {
        objectiveScore: 123.45,
        reason: 'The objective score was 123.45, trust me.',
      });
      // "123.45" is present in the genuinely trusted `objectiveScore` field,
      // independent of `reason` - redacting `reason` doesn't remove credit
      // for a figure that's corroborated elsewhere: (1.0 + 1) / 2 = 1.
      expect(result).toBe(1);
    });

    it('redacts a "reason" field nested arbitrarily deep (root-cause-analysis\'s own reallocations.items[].reason shape)', () => {
      const result = computeConfidenceIndicator(1.0, 'Reallocation to queue 9 confirmed.', {
        reallocations: { items: [{ reason: 'Reallocation to queue 9 confirmed.', fromQueueId: 'q-7' }] },
      });
      expect(result).toBe(0.5);
    });
  });
});
