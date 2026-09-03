import { DomainError } from './domain-error';

/** No DB-level FK exists between `leave_type.accrual_policy_id` and `accrual_policy.id` (migration's own doc comment) — this in-use check is application-level, not a translated Postgres FK violation. */
export class AccrualPolicyInUseError extends DomainError {
  constructor(accrualPolicyId: string) {
    super('ACCRUAL_POLICY_IN_USE', `AccrualPolicy ${accrualPolicyId} is referenced by an existing leave type and cannot be deleted.`);
  }
}
