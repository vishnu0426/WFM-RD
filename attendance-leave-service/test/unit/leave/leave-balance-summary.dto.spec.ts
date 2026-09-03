import { toLeaveBalanceSummary } from '../../../src/leave/dto/leave-balance-summary.dto';
import { LeaveBalance } from '../../../src/leave/entities/leave-balance.entity';

function buildBalance(overrides: Partial<LeaveBalance> = {}): LeaveBalance {
  return {
    employeeId: 'emp-1',
    leaveTypeId: 'lt-1',
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    tenantId: 'tenant-1',
    accruedDays: '20.00',
    usedDays: '5.00',
    pendingDays: '2.00',
    carryoverDaysIn: '1.50',
    carryoverExpiryDate: null,
    carryoverApplied: false,
    lastAccruedAt: null,
    ...overrides,
  };
}

describe('toLeaveBalanceSummary', () => {
  it('computes availableDays as accruedDays - usedDays - pendingDays', () => {
    const result = toLeaveBalanceSummary(buildBalance());

    expect(result.availableDays).toBe('13.00');
  });

  it('carries the rest of the fields through unchanged', () => {
    const result = toLeaveBalanceSummary(buildBalance());

    expect(result).toMatchObject({
      leaveTypeId: 'lt-1',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      accruedDays: '20.00',
      usedDays: '5.00',
      pendingDays: '2.00',
      carryoverDaysIn: '1.50',
      carryoverExpiryDate: null,
    });
  });

  it('handles a fully-depleted balance (availableDays can be zero)', () => {
    const result = toLeaveBalanceSummary(
      buildBalance({ accruedDays: '10.00', usedDays: '10.00', pendingDays: '0.00' }),
    );

    expect(result.availableDays).toBe('0.00');
  });
});
