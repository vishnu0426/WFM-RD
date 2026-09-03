import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { AttendanceExceptionType, AttendanceSource } from '../../src/attendance/entities/attendance-record.entity';
import { AbsencePatternType } from '../../src/leave/entities/absence-pattern.entity';
import { LeaveBalance } from '../../src/leave/entities/leave-balance.entity';
import { LeaveRequestStatus } from '../../src/leave/entities/leave-request.entity';
import { entities } from '../../src/database/entities';

/**
 * Verifies the TypeORM entity classes agree with the §2.1 DDL and the
 * ADR-0003 enum-representation convention (a real TS enum backs every
 * varchar+CHECK column) - catches an entity/migration drift that a
 * TypeScript compile alone would not.
 */
describe('database entities', () => {
  it("registers all seven entities (§2.1's five plus Phase 2's attendance_ingestion_event plus the User Management audit's GAP-02 accrual_policy), scoped to the attendance_leave schema", () => {
    expect(entities).toHaveLength(7);
    const entitySet = new Set<unknown>(entities);
    const tables = getMetadataArgsStorage().tables.filter((t) => entitySet.has(t.target));
    expect(tables).toHaveLength(7);
    for (const table of tables) {
      expect(table.schema).toBe('attendance_leave');
    }
  });

  it("AttendanceSource matches §2.1's enum exactly", () => {
    expect(Object.values(AttendanceSource).sort()).toEqual(['badge', 'biometric', 'manual', 'mobile_app'].sort());
  });

  it("AttendanceExceptionType matches §2.1's original four plus Module 11 Phase 6's geofence_violation (docs/adr/0155)", () => {
    expect(Object.values(AttendanceExceptionType).sort()).toEqual(
      ['early_leave', 'geofence_violation', 'late', 'no_show', 'unscheduled_work'].sort(),
    );
  });

  it("LeaveRequestStatus matches §2.1's enum exactly", () => {
    expect(Object.values(LeaveRequestStatus).sort()).toEqual(['approved', 'cancelled', 'pending', 'rejected'].sort());
  });

  it("AbsencePatternType matches §2.1's enum exactly", () => {
    expect(Object.values(AbsencePatternType).sort()).toEqual(
      ['frequency_threshold', 'pre_post_holiday', 'recurring_day_of_week'].sort(),
    );
  });

  it("LeaveBalance's composite PK columns match §2.1/ADR-0074 exactly", () => {
    const columns = getMetadataArgsStorage()
      .columns.filter((c) => c.target === LeaveBalance)
      .filter((c) => c.options.primary)
      .map((c) => c.propertyName)
      .sort();
    expect(columns).toEqual(['employeeId', 'leaveTypeId', 'periodEnd', 'periodStart'].sort());
  });
});
