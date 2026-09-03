import { applyFieldMappings } from '../../../src/sync/batch/providers/field-mapping-transform';
import { FieldMapping, FieldMappingAuthority } from '../../../src/integrations/entities/field-mapping.entity';

function mapping(overrides: Partial<FieldMapping>): FieldMapping {
  return {
    id: 'm1',
    tenantId: 't1',
    connectorId: 'c1',
    sourceField: 'x',
    targetField: 'y',
    transformationRule: null,
    authority: null,
    ...overrides,
  } as FieldMapping;
}

describe('applyFieldMappings', () => {
  it('renames a top-level field with no transform', () => {
    const result = applyFieldMappings({ workerId: 'WD-1' }, [
      mapping({ sourceField: 'workerId', targetField: 'employeeNumber' }),
    ]);
    expect(result).toEqual({ employeeNumber: 'WD-1' });
  });

  it('extracts a nested dot-path field', () => {
    const result = applyFieldMappings({ position: { organization: { id: 'org-1' } } }, [
      mapping({ sourceField: 'position.organization.id', targetField: 'orgUnitId' }),
    ]);
    expect(result).toEqual({ orgUnitId: 'org-1' });
  });

  it('applies a valueMap transform (Workday-shaped enum -> Module 02 enum)', () => {
    const result = applyFieldMappings({ employmentType: 'Full-Time' }, [
      mapping({
        sourceField: 'employmentType',
        targetField: 'employmentType',
        transformationRule: { valueMap: { 'Full-Time': 'full_time', 'Part-Time': 'part_time' } },
      }),
    ]);
    expect(result).toEqual({ employmentType: 'full_time' });
  });

  it('leaves an unmapped valueMap value unchanged', () => {
    const result = applyFieldMappings({ employmentType: 'Something-Unexpected' }, [
      mapping({
        sourceField: 'employmentType',
        targetField: 'employmentType',
        transformationRule: { valueMap: { 'Full-Time': 'full_time' } },
      }),
    ]);
    expect(result).toEqual({ employmentType: 'Something-Unexpected' });
  });

  it('applies a multiply transform (FTE fraction -> hours/week)', () => {
    const result = applyFieldMappings({ fte: 1.0 }, [
      mapping({ sourceField: 'fte', targetField: 'contractHoursPerWeek', transformationRule: { multiply: 40 } }),
    ]);
    expect(result).toEqual({ contractHoursPerWeek: 40 });
  });

  it('drops fields with no matching mapping - only explicitly mapped data reaches the target', () => {
    const result = applyFieldMappings({ workerId: 'WD-1', internalNotes: 'do not sync' }, [
      mapping({ sourceField: 'workerId', targetField: 'employeeNumber' }),
    ]);
    expect(result).toEqual({ employeeNumber: 'WD-1' });
    expect(result).not.toHaveProperty('internalNotes');
  });

  it('skips a mapping whose source path is absent in the raw record', () => {
    const result = applyFieldMappings({}, [mapping({ sourceField: 'missing.path', targetField: 'employeeNumber' })]);
    expect(result).toEqual({});
  });

  it('ignores authority (irrelevant to the transform itself, present only for schema completeness)', () => {
    const result = applyFieldMappings({ workerId: 'WD-1' }, [
      mapping({
        sourceField: 'workerId',
        targetField: 'employeeNumber',
        authority: FieldMappingAuthority.SOURCE_AUTHORITATIVE,
      }),
    ]);
    expect(result).toEqual({ employeeNumber: 'WD-1' });
  });
});
