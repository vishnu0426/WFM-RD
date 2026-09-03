import { DomainError } from './domain-error';

/**
 * `LeaveBalance`'s primary key is the composite
 * `(employeeId, leaveTypeId, periodStart, periodEnd)` (see the entity's own
 * doc comment) - provisioning a second row for the same key would silently
 * shadow or conflict with the first rather than accrue into it. Callers
 * needing to adjust an already-provisioned period should use a distinct
 * adjustment path, not re-provision - not built in this pass, since no
 * caller of the new provisioning endpoint needs it yet.
 */
export class LeaveBalanceAlreadyExistsError extends DomainError {
  constructor(employeeId: string, leaveTypeId: string, periodStart: string, periodEnd: string) {
    super(
      'LEAVE_BALANCE_ALREADY_EXISTS',
      `A LeaveBalance record already exists for employee ${employeeId} / leave type ${leaveTypeId} covering ${periodStart}..${periodEnd}.`,
    );
  }
}
