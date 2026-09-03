import { Employee } from '../../employee/entities/employee.entity';
import { BulkImportRecordDto } from '../dto/bulk-import-record.dto';

export interface FieldChange {
  old: unknown;
  new: unknown;
}

/**
 * Field-by-field comparison behind the dry-run diff report's `updates`
 * entries (§3.2: "returns a diff report (creates/updates/conflicts)").
 * Only compares the fields bulk import can actually change - `userId` and
 * `hireDate` are intentionally excluded (an HRIS re-sending an employee's
 * original hire date shouldn't be treated as a change worth reporting, and
 * this phase's bulk import doesn't touch `userId`).
 */
export function diffEmployeeRecord(existing: Employee, record: BulkImportRecordDto): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};

  if (existing.orgUnitId !== record.orgUnitId) {
    changes.orgUnitId = { old: existing.orgUnitId, new: record.orgUnitId };
  }
  if (existing.employmentType !== record.employmentType) {
    changes.employmentType = { old: existing.employmentType, new: record.employmentType };
  }
  if (Number(existing.contractHoursPerWeek) !== record.contractHoursPerWeek) {
    changes.contractHoursPerWeek = { old: Number(existing.contractHoursPerWeek), new: record.contractHoursPerWeek };
  }
  const newCostCenter = record.costCenter ?? null;
  if (existing.costCenter !== newCostCenter) {
    changes.costCenter = { old: existing.costCenter, new: newCostCenter };
  }
  const newManagerId = record.managerEmployeeId ?? null;
  if (existing.managerEmployeeId !== newManagerId) {
    changes.managerEmployeeId = { old: existing.managerEmployeeId, new: newManagerId };
  }

  return changes;
}
