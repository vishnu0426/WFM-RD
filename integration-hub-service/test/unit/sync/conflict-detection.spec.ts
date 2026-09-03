import { detectFieldAuthorityConflicts } from '../../../src/sync/batch/conflict-detection';
import {
  FieldAuthorityPolicy,
  FieldAuthoritySource,
  FieldConflictAction,
} from '../../../src/integrations/entities/field-authority-policy.entity';
import { BulkImportJobResult } from '../../../src/sync/batch/providers/bulk-import-client.service';

function policy(overrides: Partial<FieldAuthorityPolicy>): FieldAuthorityPolicy {
  return {
    id: 'p1',
    tenantId: 't1',
    connectorId: 'c1',
    fieldName: 'costCenter',
    authoritativeSource: FieldAuthoritySource.AGNO_WFM,
    conflictAction: FieldConflictAction.FLAG_FOR_REVIEW,
    ...overrides,
  } as FieldAuthorityPolicy;
}

function dryRunResult(updates: NonNullable<BulkImportJobResult['result']>['updates']): BulkImportJobResult {
  return {
    id: 'job1',
    status: 'completed',
    dryRun: true,
    totalRecords: updates.length,
    result: { creates: [], updates, conflicts: [] },
    error: null,
  };
}

describe('detectFieldAuthorityConflicts', () => {
  it('produces no conflicts when no policy is agno_wfm-authoritative for the changed field', () => {
    const result = detectFieldAuthorityConflicts(
      dryRunResult([{ employeeNumber: 'E1', changes: { costCenter: { old: 'CC-1', new: 'CC-2' } } }]),
      [policy({ fieldName: 'costCenter', authoritativeSource: FieldAuthoritySource.EXTERNAL_SYSTEM })],
    );
    expect(result.conflicts).toHaveLength(0);
    expect(result.recordsToReject.size).toBe(0);
    expect(result.fieldRevertsByEmployee.size).toBe(0);
  });

  it('produces no conflicts for a field with no configured policy at all', () => {
    const result = detectFieldAuthorityConflicts(
      dryRunResult([{ employeeNumber: 'E1', changes: { employmentType: { old: 'full_time', new: 'part_time' } } }]),
      [policy({ fieldName: 'costCenter' })],
    );
    expect(result.conflicts).toHaveLength(0);
  });

  it('flag_for_review: records a conflict and reverts the field to the Agno (old) value, keeps the record for commit', () => {
    const result = detectFieldAuthorityConflicts(
      dryRunResult([{ employeeNumber: 'E1', changes: { costCenter: { old: 'CC-AGNO', new: 'CC-WORKDAY' } } }]),
      [policy({ fieldName: 'costCenter', conflictAction: FieldConflictAction.FLAG_FOR_REVIEW })],
    );
    expect(result.conflicts).toEqual([
      {
        employeeNumber: 'E1',
        fieldName: 'costCenter',
        agnoValue: 'CC-AGNO',
        incomingValue: 'CC-WORKDAY',
        conflictAction: 'flag_for_review',
      },
    ]);
    expect(result.recordsToReject.size).toBe(0);
    expect(result.fieldRevertsByEmployee.get('E1')).toEqual({ costCenter: 'CC-AGNO' });
  });

  it('reject_sync: records a conflict and marks the whole employee record for exclusion from commit', () => {
    const result = detectFieldAuthorityConflicts(
      dryRunResult([{ employeeNumber: 'E1', changes: { costCenter: { old: 'CC-AGNO', new: 'CC-WORKDAY' } } }]),
      [policy({ fieldName: 'costCenter', conflictAction: FieldConflictAction.REJECT_SYNC })],
    );
    expect(result.recordsToReject.has('E1')).toBe(true);
    expect(result.fieldRevertsByEmployee.size).toBe(0);
  });

  it('overwrite: records a conflict for visibility but neither rejects nor reverts anything', () => {
    const result = detectFieldAuthorityConflicts(
      dryRunResult([{ employeeNumber: 'E1', changes: { costCenter: { old: 'CC-AGNO', new: 'CC-WORKDAY' } } }]),
      [policy({ fieldName: 'costCenter', conflictAction: FieldConflictAction.OVERWRITE })],
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.recordsToReject.size).toBe(0);
    expect(result.fieldRevertsByEmployee.size).toBe(0);
  });

  it('handles multiple conflicting fields on the same employee independently', () => {
    const result = detectFieldAuthorityConflicts(
      dryRunResult([
        {
          employeeNumber: 'E1',
          changes: {
            costCenter: { old: 'CC-AGNO', new: 'CC-WORKDAY' },
            employmentType: { old: 'full_time', new: 'part_time' },
          },
        },
      ]),
      [
        policy({ fieldName: 'costCenter', conflictAction: FieldConflictAction.FLAG_FOR_REVIEW }),
        policy({ fieldName: 'employmentType', conflictAction: FieldConflictAction.OVERWRITE }),
      ],
    );
    expect(result.conflicts).toHaveLength(2);
    expect(result.fieldRevertsByEmployee.get('E1')).toEqual({ costCenter: 'CC-AGNO' });
  });

  it('handles multiple employees independently', () => {
    const result = detectFieldAuthorityConflicts(
      dryRunResult([
        { employeeNumber: 'E1', changes: { costCenter: { old: 'A', new: 'B' } } },
        { employeeNumber: 'E2', changes: { costCenter: { old: 'C', new: 'D' } } },
      ]),
      [policy({ fieldName: 'costCenter', conflictAction: FieldConflictAction.REJECT_SYNC })],
    );
    expect(result.recordsToReject).toEqual(new Set(['E1', 'E2']));
  });

  it('a create (brand-new employee) never conflicts - creates are absent from `updates` entirely', () => {
    const result = detectFieldAuthorityConflicts(
      {
        id: 'job1',
        status: 'completed',
        dryRun: true,
        totalRecords: 1,
        result: { creates: [{ employeeNumber: 'E-NEW' }], updates: [], conflicts: [] },
        error: null,
      },
      [policy({ fieldName: 'costCenter', conflictAction: FieldConflictAction.REJECT_SYNC })],
    );
    expect(result.conflicts).toHaveLength(0);
  });

  it('returns empty results when the dry-run result has no updates array at all', () => {
    const result = detectFieldAuthorityConflicts(
      { id: 'job1', status: 'completed', dryRun: true, totalRecords: 0, result: null, error: null },
      [policy({})],
    );
    expect(result.conflicts).toHaveLength(0);
    expect(result.recordsToReject.size).toBe(0);
  });
});
