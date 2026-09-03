/**
 * The subset of `PolicyType` (ADR-0012) that `createEmploymentPolicy` (§3.1)
 * may create. A separate, narrower enum rather than reusing `PolicyType`
 * directly in the GraphQL input: `PolicyType` also carries Module 01's five
 * tenant-wide policy types and `SKILL_DECAY_HALF_LIFE` (Phase 4, ADR-0017,
 * tenant-wide only, not org-unit-scoped like these four) - exposing the
 * full enum here would let a caller create, say, a `data_retention` row
 * through a mutation named `createEmploymentPolicy`, which is exactly the
 * kind of type confusion a narrower enum avoids. Values are string-identical
 * to their `PolicyType` counterparts so `EmploymentPoliciesService` can cast
 * directly rather than mapping.
 */
export enum EmploymentPolicyType {
  OVERTIME_THRESHOLD = 'overtime_threshold',
  REST_PERIOD_MINIMUM = 'rest_period_minimum',
  MAX_CONSECUTIVE_DAYS = 'max_consecutive_days',
  UNION_RULE = 'union_rule',
}
