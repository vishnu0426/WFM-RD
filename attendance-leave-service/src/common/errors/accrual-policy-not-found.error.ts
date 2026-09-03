import { DomainError } from './domain-error';

export class AccrualPolicyNotFoundError extends DomainError {
  constructor(accrualPolicyId: string) {
    super('ACCRUAL_POLICY_NOT_FOUND', `No AccrualPolicy exists with id ${accrualPolicyId}.`);
  }
}
