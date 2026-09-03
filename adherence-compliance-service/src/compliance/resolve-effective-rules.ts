import { ComplianceRule, ComplianceRuleStatus, ComplianceRuleType } from './entities/compliance-rule.entity';

/**
 * §3.2's `GET /v1/compliance/rules/{jurisdiction}` ("the REST-equivalent of
 * the gRPC contract Module 04 uses; keep the two in sync as one canonical
 * rule representation") and, eventually, Phase 4's `ComplianceRuleService.GetActiveRule`
 * gRPC method share this exact resolution algorithm rather than each
 * reimplementing it — the same "one canonical representation" instruction
 * applied to code, not just to the wire format.
 *
 * "Effective" means: `status IN ('active', 'superseded')`, `effectiveFrom
 * <= asOf`, `effectiveTo` either unset or `>= asOf`, and — §5a/§0.5's
 * progressive-delivery field — `activationDelayUntil` either unset or
 * `<= asOf`. A row whose status is `'active'` but whose
 * `activationDelayUntil` is still in the future has been reviewed and
 * approved to go live, but is not yet actually in force; treating
 * `status = 'active'` alone as "in effect" would ignore the one field this
 * module added specifically to prevent that.
 *
 * Enterprise readiness audit (2026-08-18), GAP-03, P0 fix: `superseded` is
 * included deliberately, not a leftover. `activateRule` flips the
 * previously-active row for a `(tenant, jurisdiction, ruleType)` scope to
 * `superseded` but never touches its `effectiveFrom`/`effectiveTo` — those
 * stay exactly what the admin set at `createRule` time. Filtering this
 * function to `status = 'active'` only (the pre-fix behavior) meant a
 * historical `asOf` predating the *current* rule's `effectiveFrom` could
 * never resolve to anything, even though a `superseded` row's own
 * effective window still genuinely covered that date — silently producing
 * "no rule found" for periods that had a real, citable rule in force at
 * the time. Including `superseded` rows and still filtering by each row's
 * own effective window is safe: `isMoreSpecific`'s existing version
 * tie-break below already picks the highest-version row among however many
 * rows' windows happen to cover a given `asOf` (which is exactly what
 * makes today's/future lookups still resolve to the current `active` row
 * even without ever backfilling an old row's open-ended `effectiveTo`).
 * `pending_review`/`rejected` rows are still excluded unconditionally —
 * neither was ever actually in force for any date.
 *
 * Within a jurisdiction, at most one row per `ruleType` is returned:
 * a tenant-scoped override always wins over the platform default for the
 * same `ruleType` (§2.2 rule 3's whole point), never both. This phase does
 * not implement the "is the override at least as strict as the floor"
 * comparison (§2.2 rule 3's closing sentence, ADR-0095's flagged gap) —
 * that is Phase 4's `ValidatePolicyAgainstFloor` deliverable, shared by
 * both this read path and Module 02's `EmploymentPolicy` write path rather
 * than reimplemented twice.
 */
export function resolveEffectiveRules(rules: ComplianceRule[], asOf: Date): ComplianceRule[] {
  const inForce = rules.filter(
    (rule) =>
      (rule.status === ComplianceRuleStatus.ACTIVE || rule.status === ComplianceRuleStatus.SUPERSEDED) &&
      rule.effectiveFrom <= isoDate(asOf) &&
      (rule.effectiveTo === null || rule.effectiveTo >= isoDate(asOf)) &&
      (rule.activationDelayUntil === null || rule.activationDelayUntil <= asOf),
  );

  const byRuleType = new Map<ComplianceRuleType, ComplianceRule>();
  for (const rule of inForce) {
    const current = byRuleType.get(rule.ruleType);
    if (!current || isMoreSpecific(rule, current)) {
      byRuleType.set(rule.ruleType, rule);
    }
  }
  return [...byRuleType.values()];
}

/** A tenant-scoped row (`tenantId !== null`) is always more specific than a platform default; among two tenant-scoped or two platform-default rows, the higher version wins. */
function isMoreSpecific(candidate: ComplianceRule, current: ComplianceRule): boolean {
  const candidateIsTenantScoped = candidate.tenantId !== null;
  const currentIsTenantScoped = current.tenantId !== null;
  if (candidateIsTenantScoped !== currentIsTenantScoped) {
    return candidateIsTenantScoped;
  }
  return candidate.version > current.version;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
