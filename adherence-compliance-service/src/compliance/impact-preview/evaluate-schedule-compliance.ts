import { ComplianceRuleType } from '../entities/compliance-rule.entity';

export interface SimulatedShift {
  employeeId: string;
  start: Date;
  end: Date;
}

/**
 * §5a/docs/adr/0104: "re-run the constraint check against currently-published
 * schedules" - a real, disclosed re-expression of each rule type's
 * arithmetic against concrete shift timestamps, the same posture
 * scheduling-service's own `app/solver/eligibility.py` took for its
 * CP-SAT constraints (same window/cap logic, evaluated without a solver).
 * Buckets by UTC calendar day, not the employee's own local timezone -
 * acceptable for a *preview* (this function never gates a real schedule,
 * only estimates who a proposed rule would newly affect) or a *report*
 * (Phase 6, docs/adr/0105 - an audit trail, not a payroll calculation).
 * Module 08's Phase 3 rollup is the authoritative, genuinely-timezone-aware
 * computation, unrelated to this one.
 *
 * `break_requirement` has no case here beyond "never violated" - no
 * schedule-derivable signal exists for "was a break actually taken"
 * (`ShiftAssignment` records start/end only), and `union_rule`'s own
 * `mandatoryBreakAfterHours`/`mandatoryBreakMinutes` fields are skipped for
 * the same reason (only `minShiftLengthMinutes`/`maxShiftLengthMinutes` are
 * checked) - a disclosed simulation-coverage gap, not a silent one.
 *
 * `findViolations` is the primary function - `isCompliant` is a thin
 * `.length === 0` wrapper over it (Phase 5's original caller,
 * `RuleChangeImpactPreviewService`, only ever needed the boolean; Phase 6's
 * `overtime_audit`/`rest_period_audit` reports need the actual list). One
 * set of per-`ruleType` arithmetic, not two - a boolean-only and a
 * message-collecting copy would be a real drift risk for zero benefit.
 */
export function findViolations(
  ruleType: ComplianceRuleType,
  definition: Record<string, unknown>,
  shifts: SimulatedShift[],
): string[] {
  switch (ruleType) {
    case ComplianceRuleType.OVERTIME_THRESHOLD:
      return checkOvertimeThreshold(shifts, definition);
    case ComplianceRuleType.REST_PERIOD_MINIMUM:
      return checkRestPeriodMinimum(shifts, definition);
    case ComplianceRuleType.MAX_CONSECUTIVE_DAYS:
      return checkMaxConsecutiveDays(shifts, definition);
    case ComplianceRuleType.UNION_RULE:
      return checkUnionRule(shifts, definition);
    case ComplianceRuleType.BREAK_REQUIREMENT:
      return [];
  }
}

export function isCompliant(
  ruleType: ComplianceRuleType,
  definition: Record<string, unknown>,
  shifts: SimulatedShift[],
): boolean {
  return findViolations(ruleType, definition, shifts).length === 0;
}

function numberField(definition: Record<string, unknown>, field: string): number | null {
  if (!(field in definition) || definition[field] === null || definition[field] === undefined) {
    return null;
  }
  const value = Number(definition[field]);
  return Number.isNaN(value) ? null : value;
}

function durationHours(shift: SimulatedShift): number {
  return (shift.end.getTime() - shift.start.getTime()) / (60 * 60 * 1000);
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Monday-start ISO week, same convention as `solve_input_resolver.py`'s own `_week_start`. */
function isoWeekStartKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDayOfWeek = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // 1=Mon..7=Sun
  d.setUTCDate(d.getUTCDate() - (isoDayOfWeek - 1));
  return utcDateKey(d);
}

function checkOvertimeThreshold(shifts: SimulatedShift[], definition: Record<string, unknown>): string[] {
  const dailyThresholdHours = numberField(definition, 'dailyThresholdHours');
  const weeklyThresholdHours = numberField(definition, 'weeklyThresholdHours');
  if (dailyThresholdHours === null && weeklyThresholdHours === null) {
    return [];
  }

  const hoursByDay = new Map<string, number>();
  const hoursByWeek = new Map<string, number>();
  for (const shift of shifts) {
    const hours = durationHours(shift);
    const dayKey = utcDateKey(shift.start);
    hoursByDay.set(dayKey, (hoursByDay.get(dayKey) ?? 0) + hours);
    const weekKey = isoWeekStartKey(shift.start);
    hoursByWeek.set(weekKey, (hoursByWeek.get(weekKey) ?? 0) + hours);
  }

  const violations: string[] = [];
  if (dailyThresholdHours !== null) {
    for (const [day, hours] of [...hoursByDay].sort()) {
      if (hours > dailyThresholdHours) {
        violations.push(`worked ${hours.toFixed(2)}h on ${day} (daily threshold ${dailyThresholdHours}h)`);
      }
    }
  }
  if (weeklyThresholdHours !== null) {
    for (const [week, hours] of [...hoursByWeek].sort()) {
      if (hours > weeklyThresholdHours) {
        violations.push(
          `worked ${hours.toFixed(2)}h in the week of ${week} (weekly threshold ${weeklyThresholdHours}h)`,
        );
      }
    }
  }
  return violations;
}

function checkRestPeriodMinimum(shifts: SimulatedShift[], definition: Record<string, unknown>): string[] {
  const minRestHoursBetweenShifts = numberField(definition, 'minRestHoursBetweenShifts');
  if (minRestHoursBetweenShifts === null) {
    return [];
  }
  const sorted = [...shifts].sort((a, b) => a.start.getTime() - b.start.getTime());
  const minRestMs = minRestHoursBetweenShifts * 60 * 60 * 1000;
  const violations: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gapMs = sorted[i].start.getTime() - sorted[i - 1].end.getTime();
    if (gapMs < minRestMs) {
      const gapHours = (gapMs / (60 * 60 * 1000)).toFixed(2);
      violations.push(
        `only ${gapHours}h rest between the shift ending ${sorted[i - 1].end.toISOString()} and the shift starting ${sorted[i].start.toISOString()} (minimum ${minRestHoursBetweenShifts}h)`,
      );
    }
  }
  return violations;
}

/**
 * Same "window = cap + 1 days, count worked days in window" rule as
 * `app/solver/eligibility.py`'s `_would_exceed_max_consecutive_days`, but
 * re-expressed as "any contiguous run of worked calendar days longer than
 * the cap" - a window of `cap + 1` days can only exceed the cap if every
 * day in it is worked (there is no room for even one rest day once the
 * count exceeds `cap` within `cap + 1` days), which is exactly a
 * contiguous run of length `>= cap + 1`. Equivalent to the sliding-window
 * form, but reports one clean violation per run instead of one per
 * overlapping window - the shape a report needs, not a preview's bare
 * boolean.
 */
function checkMaxConsecutiveDays(shifts: SimulatedShift[], definition: Record<string, unknown>): string[] {
  const maxConsecutiveWorkingDays = numberField(definition, 'maxConsecutiveWorkingDays');
  if (maxConsecutiveWorkingDays === null) {
    return [];
  }
  const workedDates = [...new Set(shifts.map((s) => utcDateKey(s.start)))].sort();
  const violations: string[] = [];
  let runStart: string | null = null;
  let runLength = 0;
  let previous: string | null = null;

  const closeRun = (lastDateInRun: string): void => {
    if (runStart !== null && runLength > maxConsecutiveWorkingDays) {
      violations.push(
        `worked ${runLength} consecutive days from ${runStart} to ${lastDateInRun} (max ${maxConsecutiveWorkingDays})`,
      );
    }
  };

  for (const dateKey of workedDates) {
    const isConsecutive = previous !== null && isNextCalendarDay(previous, dateKey);
    if (isConsecutive) {
      runLength++;
    } else {
      if (previous !== null) {
        closeRun(previous);
      }
      runStart = dateKey;
      runLength = 1;
    }
    previous = dateKey;
  }
  if (previous !== null) {
    closeRun(previous);
  }
  return violations;
}

function isNextCalendarDay(dateKey: string, candidateKey: string): boolean {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return utcDateKey(date) === candidateKey;
}

function checkUnionRule(shifts: SimulatedShift[], definition: Record<string, unknown>): string[] {
  const minShiftLengthMinutes = numberField(definition, 'minShiftLengthMinutes');
  const maxShiftLengthMinutes = numberField(definition, 'maxShiftLengthMinutes');
  if (minShiftLengthMinutes === null && maxShiftLengthMinutes === null) {
    return [];
  }
  const violations: string[] = [];
  for (const shift of shifts) {
    const lengthMinutes = durationHours(shift) * 60;
    if (minShiftLengthMinutes !== null && lengthMinutes < minShiftLengthMinutes) {
      violations.push(
        `shift starting ${shift.start.toISOString()} is ${lengthMinutes}min, below the minimum ${minShiftLengthMinutes}min`,
      );
    }
    if (maxShiftLengthMinutes !== null && lengthMinutes > maxShiftLengthMinutes) {
      violations.push(
        `shift starting ${shift.start.toISOString()} is ${lengthMinutes}min, above the maximum ${maxShiftLengthMinutes}min`,
      );
    }
  }
  return violations;
}
