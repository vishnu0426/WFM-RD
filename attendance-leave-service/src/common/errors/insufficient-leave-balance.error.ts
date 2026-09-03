import { DomainError } from './domain-error';

/** §2.2 rule 1: requestedDays exceeds availableDays (accruedDays - usedDays - pendingDays) under the row lock. */
export class InsufficientLeaveBalanceError extends DomainError {
  constructor(requestedDays: number, availableDays: number) {
    super(
      'INSUFFICIENT_LEAVE_BALANCE',
      `Requested ${requestedDays} day(s) but only ${availableDays} day(s) are available.`,
    );
  }
}
