import { FieldMapping } from '../../../integrations/entities/field-mapping.entity';

/** Dot-path extraction (`position.organization.id`) - real providers' raw payloads are nested; this module's own fake test fixtures happen to be flat, but the adapter shouldn't assume that. */
function getByPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value !== null && typeof value === 'object' && key in (value as Record<string, unknown>)) {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

/**
 * The two `transformationRule` shapes Phase 3 actually needs and
 * implements, not a generic rule engine: `valueMap` (enum-string
 * translation, e.g. Workday's `"Full-Time"` -> Module 02's `"full_time"`)
 * and `multiply` (numeric scaling, e.g. Workday's FTE fraction `1.0` ->
 * hours/week `40`). `transformationRule` is real, provider-agnostic jsonb
 * (§2.1) - a future phase can add more shapes here without a schema
 * change; this phase intentionally doesn't build more than these two,
 * since nothing yet needs a third.
 */
function applyTransform(rawValue: unknown, transformationRule: Record<string, unknown> | null): unknown {
  if (!transformationRule) return rawValue;
  if (typeof transformationRule.valueMap === 'object' && transformationRule.valueMap !== null) {
    const map = transformationRule.valueMap as Record<string, unknown>;
    return typeof rawValue === 'string' && rawValue in map ? map[rawValue] : rawValue;
  }
  if (typeof transformationRule.multiply === 'number') {
    return typeof rawValue === 'number' ? rawValue * transformationRule.multiply : rawValue;
  }
  return rawValue;
}

/** Applies every `FieldMapping` for this connector to one raw source record, producing a flat target-field-keyed object. Fields with no mapping are dropped, not passed through - only explicitly mapped data reaches Module 02. */
export function applyFieldMappings(
  rawRecord: Record<string, unknown>,
  mappings: FieldMapping[],
): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const mapping of mappings) {
    const rawValue = getByPath(rawRecord, mapping.sourceField);
    if (rawValue === undefined) continue;
    target[mapping.targetField] = applyTransform(rawValue, mapping.transformationRule);
  }
  return target;
}
