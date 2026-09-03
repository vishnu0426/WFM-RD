import { Injectable } from '@nestjs/common';

export interface RiskEvaluationContext {
  affectedEmployeeCount: number;
  confidenceIndicator: number | null;
}

export interface RiskEvaluationResult {
  passed: boolean;
  failedCriteria: string[];
}

/**
 * §3's concrete `auto_execute_low_risk` gate - "define the actual
 * evaluated criteria ... this is what `auto_execute_low_risk` actually
 * gates on, not a vague 'low risk' label." Two criteria are implemented
 * today, both backed by real, already-available signals:
 *
 * - `maxAffectedEmployees` (number) - checked against the recommendation's
 *   own `affectedEmployeeCount` (e.g. `ReallocationAction.affectedEmployeeIds.length`).
 * - `minConfidenceIndicator` (number) - checked against the generating
 *   `AIInteraction.confidence_indicator` (§0.5's own documented formula,
 *   ADR-0113's `confidence-indicator.ts`).
 *
 * §3's third named example, "no overtime cost impact," is NOT implemented -
 * no recommendation source this module has built (reallocation) carries
 * cost data anywhere in its own structured data. Naming it in
 * `risk_threshold_config` has no effect; only the two criteria above are
 * ever evaluated. A config with no recognized criteria at all fails
 * closed (never auto-executes) rather than silently passing - the same
 * "an unconfigured gate defaults to the safest outcome" posture §3 itself
 * establishes for the autonomy-level resolution order (ADR-0114).
 */
@Injectable()
export class RiskThresholdEvaluatorService {
  evaluate(riskThresholdConfig: Record<string, unknown>, context: RiskEvaluationContext): RiskEvaluationResult {
    const failedCriteria: string[] = [];
    let hasAnyRecognizedCriterion = false;

    if (typeof riskThresholdConfig.maxAffectedEmployees === 'number') {
      hasAnyRecognizedCriterion = true;
      if (context.affectedEmployeeCount > riskThresholdConfig.maxAffectedEmployees) {
        failedCriteria.push(
          `affectedEmployeeCount (${context.affectedEmployeeCount}) exceeds maxAffectedEmployees (${riskThresholdConfig.maxAffectedEmployees})`,
        );
      }
    }

    if (typeof riskThresholdConfig.minConfidenceIndicator === 'number') {
      hasAnyRecognizedCriterion = true;
      if (
        context.confidenceIndicator === null ||
        context.confidenceIndicator < riskThresholdConfig.minConfidenceIndicator
      ) {
        failedCriteria.push(
          `confidenceIndicator (${context.confidenceIndicator}) below minConfidenceIndicator (${riskThresholdConfig.minConfidenceIndicator})`,
        );
      }
    }

    if (!hasAnyRecognizedCriterion) {
      failedCriteria.push(
        'risk_threshold_config has no recognized criteria configured - auto-execution never fires without an explicit threshold',
      );
    }

    return { passed: failedCriteria.length === 0, failedCriteria };
  }
}
