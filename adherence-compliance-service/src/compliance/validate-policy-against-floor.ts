import { ComplianceRuleType } from './entities/compliance-rule.entity';

type FieldDirection = 'lower_is_stricter' | 'higher_is_stricter';

/**
 * §0.6/§2.2 rule 3/ADR-0100: the "is this at least as strict as the floor"
 * comparison ADR-0095 and the Phase 2 design doc both flagged as a real,
 * unbuilt gap - built once, here, and shared by every caller (Module 02's
 * `EmploymentPolicy` write path via gRPC, this module's own future
 * self-override checks) rather than reimplemented per caller.
 *
 * Field-by-field, not whole-object equality - a policy can differ from the
 * floor in any way that makes it *more* protective without being rejected.
 * "Stricter direction" per field is a real, disclosed interpretation of
 * what each field means (documented per-field below and in ADR-0100), not
 * a fact derivable from the schema itself - `definition` is arbitrary
 * jsonb (§2.1 rule 4), so this platform has no other source of truth for
 * "does a higher number mean more or less protective" than this map.
 *
 * A field the floor doesn't constrain (absent from `floorDefinition`) is
 * never checked - the floor only requires what it actually specifies.
 * A field the floor *does* constrain but the policy omits is a violation -
 * fails safe, not silently inherited from somewhere else.
 */
const FIELD_DIRECTIONS: Partial<Record<ComplianceRuleType, Record<string, FieldDirection>>> = {
  // Lower threshold = overtime kicks in sooner = more protective. Higher
  // multiplier = more overtime pay owed = more protective.
  [ComplianceRuleType.OVERTIME_THRESHOLD]: {
    dailyThresholdHours: 'lower_is_stricter',
    weeklyThresholdHours: 'lower_is_stricter',
    multiplier: 'higher_is_stricter',
  },
  // More required rest between shifts = more protective.
  [ComplianceRuleType.REST_PERIOD_MINIMUM]: {
    minRestHoursBetweenShifts: 'higher_is_stricter',
  },
  // Fewer consecutive working days allowed = more protective.
  [ComplianceRuleType.MAX_CONSECUTIVE_DAYS]: {
    maxConsecutiveWorkingDays: 'lower_is_stricter',
  },
  // Same shape scheduling-service's own policy_client.py already consumes
  // for this rule type (app/grpc_clients/policy_client.py) - a longer
  // guaranteed minimum shift, a tighter maximum, a sooner mandatory break,
  // and a longer mandatory break are each independently more protective.
  [ComplianceRuleType.UNION_RULE]: {
    minShiftLengthMinutes: 'higher_is_stricter',
    maxShiftLengthMinutes: 'lower_is_stricter',
    mandatoryBreakAfterHours: 'lower_is_stricter',
    mandatoryBreakMinutes: 'higher_is_stricter',
  },
  // No EmploymentPolicy counterpart exists (Module 02's own
  // EmploymentPolicyType enum has no 'break_requirement' value) - empty on
  // purpose, not an oversight; this comparator is never called for this
  // rule type in practice.
  [ComplianceRuleType.BREAK_REQUIREMENT]: {},
};

export interface FloorValidationResult {
  valid: boolean;
  violations: string[];
}

export function validatePolicyAgainstFloor(
  ruleType: ComplianceRuleType,
  policyDefinition: Record<string, unknown>,
  floorDefinition: Record<string, unknown>,
): FloorValidationResult {
  const directions = FIELD_DIRECTIONS[ruleType] ?? {};
  const violations: string[] = [];

  for (const [field, direction] of Object.entries(directions)) {
    if (!(field in floorDefinition) || floorDefinition[field] === null || floorDefinition[field] === undefined) {
      continue;
    }
    const floorValue = Number(floorDefinition[field]);
    if (Number.isNaN(floorValue)) {
      continue;
    }

    if (!(field in policyDefinition) || policyDefinition[field] === null || policyDefinition[field] === undefined) {
      violations.push(`${field} is required by the jurisdiction's floor but is missing from this policy`);
      continue;
    }
    const policyValue = Number(policyDefinition[field]);
    if (Number.isNaN(policyValue)) {
      violations.push(`${field} must be a number to compare against the jurisdiction's floor`);
      continue;
    }

    const isAtLeastAsStrict = direction === 'lower_is_stricter' ? policyValue <= floorValue : policyValue >= floorValue;
    if (!isAtLeastAsStrict) {
      violations.push(
        `${field}=${policyValue} is less protective than the jurisdiction's floor (${field}=${floorValue})`,
      );
    }
  }

  return { valid: violations.length === 0, violations };
}
