import { ComplianceRule, ComplianceRuleType } from '../entities/compliance-rule.entity';
import { findViolations, SimulatedShift } from '../impact-preview/evaluate-schedule-compliance';

export interface CsvTable {
  headers: string[];
  rows: Array<Array<string | number>>;
}

export interface AdherenceScoreRow {
  employeeId: string;
  periodType: string;
  periodStart: Date;
  periodEnd: Date;
  adherentSeconds: number;
  totalScheduledSeconds: number;
  adherencePct: string;
  majorDeviationCount: number;
}

/** §2.1's `adherence_summary` - one row per already-computed `AdherenceScore` row in the requested range/scope. No aggregation beyond what the Phase 3 rollup already stored (§0.5's reproducibility promise: this report reads stored numbers, never recomputes them). */
export function buildAdherenceSummaryReport(scores: AdherenceScoreRow[]): CsvTable {
  return {
    headers: [
      'employeeId',
      'periodType',
      'periodStart',
      'periodEnd',
      'adherentSeconds',
      'totalScheduledSeconds',
      'adherencePct',
      'majorDeviationCount',
    ],
    rows: scores.map((s) => [
      s.employeeId,
      s.periodType,
      s.periodStart.toISOString(),
      s.periodEnd.toISOString(),
      s.adherentSeconds,
      s.totalScheduledSeconds,
      s.adherencePct,
      s.majorDeviationCount,
    ]),
  };
}

export interface EmployeeShifts {
  employeeId: string;
  shifts: SimulatedShift[];
}

/**
 * docs/adr/0105: `overtime_audit`/`rest_period_audit` are the same shape -
 * every employee's real published shifts for the period, checked against
 * one rule type's active definition, one row per violation found
 * (`findViolations`, Phase 5's simulation module, reused verbatim). `rule:
 * null` (no active rule for this jurisdiction/ruleType) produces a
 * header-only table - nothing to audit against, not an error.
 */
export function buildViolationAuditReport(
  ruleType: ComplianceRuleType,
  rule: { citation: string; definition: Record<string, unknown> } | null,
  employeeShifts: EmployeeShifts[],
): CsvTable {
  const headers = ['employeeId', 'ruleType', 'violation', 'citation'];
  if (!rule) {
    return { headers, rows: [] };
  }
  const rows: Array<Array<string | number>> = [];
  for (const { employeeId, shifts } of employeeShifts) {
    for (const violation of findViolations(ruleType, rule.definition, shifts)) {
      rows.push([employeeId, ruleType, violation, rule.citation]);
    }
  }
  return { headers, rows };
}

/**
 * §2.1's `regulator_export` - "everything a regulator would want to see
 * for this org unit": the full active `ComplianceRule` set (with
 * citations, so the legal basis for every threshold is on the record) plus
 * every violation found against the two audited rule types, in one table
 * (a `recordType` discriminator column, since CSV has no native way to mix
 * row shapes) - not a fifth, independently-designed report.
 */
export function buildRegulatorExportReport(
  activeRules: Pick<ComplianceRule, 'ruleType' | 'citation' | 'effectiveFrom'>[],
  overtimeAudit: CsvTable,
  restPeriodAudit: CsvTable,
): CsvTable {
  const headers = ['recordType', 'ruleType', 'citation', 'employeeId', 'detail'];
  const rows: Array<Array<string | number>> = [];
  for (const rule of activeRules) {
    rows.push(['active_rule', rule.ruleType, rule.citation, '', `effective from ${rule.effectiveFrom}`]);
  }
  for (const [employeeId, ruleType, violation, citation] of overtimeAudit.rows) {
    rows.push(['violation', ruleType, citation, employeeId, violation]);
  }
  for (const [employeeId, ruleType, violation, citation] of restPeriodAudit.rows) {
    rows.push(['violation', ruleType, citation, employeeId, violation]);
  }
  return { headers, rows };
}
