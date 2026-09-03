import { RiskThresholdEvaluatorService } from '../../../src/ai/risk-threshold-evaluator.service';

describe('RiskThresholdEvaluatorService.evaluate', () => {
  const service = new RiskThresholdEvaluatorService();

  it('passes when both configured criteria are met', () => {
    const result = service.evaluate(
      { maxAffectedEmployees: 5, minConfidenceIndicator: 0.8 },
      { affectedEmployeeCount: 2, confidenceIndicator: 0.9 },
    );
    expect(result).toEqual({ passed: true, failedCriteria: [] });
  });

  it('fails when affectedEmployeeCount exceeds maxAffectedEmployees', () => {
    const result = service.evaluate(
      { maxAffectedEmployees: 5, minConfidenceIndicator: 0.8 },
      { affectedEmployeeCount: 6, confidenceIndicator: 0.9 },
    );
    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toHaveLength(1);
    expect(result.failedCriteria[0]).toContain('maxAffectedEmployees');
  });

  it('fails when confidenceIndicator is below minConfidenceIndicator', () => {
    const result = service.evaluate(
      { maxAffectedEmployees: 5, minConfidenceIndicator: 0.8 },
      { affectedEmployeeCount: 2, confidenceIndicator: 0.5 },
    );
    expect(result.passed).toBe(false);
    expect(result.failedCriteria[0]).toContain('minConfidenceIndicator');
  });

  it('fails when confidenceIndicator is null but a minConfidenceIndicator threshold is configured', () => {
    const result = service.evaluate(
      { minConfidenceIndicator: 0.8 },
      { affectedEmployeeCount: 2, confidenceIndicator: null },
    );
    expect(result.passed).toBe(false);
  });

  it('fails closed when risk_threshold_config has no recognized criteria at all - never auto-executes on an unconfigured gate', () => {
    const result = service.evaluate({}, { affectedEmployeeCount: 1, confidenceIndicator: 0.99 });
    expect(result.passed).toBe(false);
    expect(result.failedCriteria[0]).toContain('no recognized criteria');
  });

  it('ignores an unrecognized criterion key (e.g. maxOvertimeCostImpact, §3 named but never implemented) without treating it as a pass-enabling criterion', () => {
    const result = service.evaluate(
      { maxOvertimeCostImpact: 0 },
      { affectedEmployeeCount: 1, confidenceIndicator: 0.99 },
    );
    expect(result.passed).toBe(false);
  });

  it('evaluates only the criteria that are actually configured (partial config)', () => {
    const result = service.evaluate(
      { maxAffectedEmployees: 5 },
      { affectedEmployeeCount: 2, confidenceIndicator: null },
    );
    expect(result.passed).toBe(true);
  });
});
