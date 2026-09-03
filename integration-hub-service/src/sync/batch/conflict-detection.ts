import {
  FieldAuthorityPolicy,
  FieldAuthoritySource,
  FieldConflictAction,
} from '../../integrations/entities/field-authority-policy.entity';
import { BulkImportJobResult } from './providers/bulk-import-client.service';

export interface FieldConflict {
  employeeNumber: string;
  fieldName: string;
  agnoValue: unknown;
  incomingValue: unknown;
  conflictAction: FieldConflictAction;
}

export interface ConflictDetectionResult {
  conflicts: FieldConflict[];
  /** `reject_sync` - the whole record is excluded from this sync's commit, not just the conflicting field. */
  recordsToReject: Set<string>;
  /** `flag_for_review` - the conflicting field is reverted to Agno's own current value before commit, keyed by employeeNumber then fieldName. */
  fieldRevertsByEmployee: Map<string, Record<string, unknown>>;
}

/**
 * §5b's conflict detection, reusing Module 02's own bulk-import dry-run
 * diff (`result.updates[].changes`, `{old, new}` per changed field) rather
 * than adding a new read call into Module 02's data - §0/§2.2 rule 3's
 * "never a Module-12-invented shortcut" cuts both ways: it also means not
 * inventing a *second* way to read Module 02's data when the sanctioned
 * write path (dry-run) already computes exactly the diff this needs. See
 * ADR-0139 for why this can't cover every field a `FieldAuthorityPolicy`
 * could theoretically name (Module 02's own diff deliberately excludes
 * `hireDate`).
 *
 * §2.2 rule 5: only policies with `authoritativeSource: agno_wfm` produce a
 * conflict - `external_system`-authoritative fields are meant to accept
 * the incoming value unconditionally, so a differing value there is
 * completely expected, not a conflict (per the spec's own detection rule:
 * "if... the field's authoritative_source is agno_wfm, that's a conflict").
 * Only `creates` (brand-new employees) never conflict - there is no
 * existing Agno value to compare against.
 */
export function detectFieldAuthorityConflicts(
  dryRunResult: BulkImportJobResult,
  policies: FieldAuthorityPolicy[],
): ConflictDetectionResult {
  const agnoAuthoritativePolicies = new Map(
    policies.filter((p) => p.authoritativeSource === FieldAuthoritySource.AGNO_WFM).map((p) => [p.fieldName, p]),
  );

  const conflicts: FieldConflict[] = [];
  const recordsToReject = new Set<string>();
  const fieldRevertsByEmployee = new Map<string, Record<string, unknown>>();

  for (const update of dryRunResult.result?.updates ?? []) {
    const changes = update.changes as Record<string, { old: unknown; new: unknown }> | undefined;
    if (!changes) continue;

    for (const [fieldName, change] of Object.entries(changes)) {
      const policy = agnoAuthoritativePolicies.get(fieldName);
      if (!policy) continue;

      conflicts.push({
        employeeNumber: update.employeeNumber,
        fieldName,
        agnoValue: change.old,
        incomingValue: change.new,
        conflictAction: policy.conflictAction,
      });

      if (policy.conflictAction === FieldConflictAction.REJECT_SYNC) {
        recordsToReject.add(update.employeeNumber);
      } else if (policy.conflictAction === FieldConflictAction.FLAG_FOR_REVIEW) {
        const reverts = fieldRevertsByEmployee.get(update.employeeNumber) ?? {};
        reverts[fieldName] = change.old;
        fieldRevertsByEmployee.set(update.employeeNumber, reverts);
      }
      // FieldConflictAction.OVERWRITE: no special handling - the incoming
      // value proceeds to commit unchanged, an explicit admin override of
      // Agno's own otherwise-authoritative value.
    }
  }

  return { conflicts, recordsToReject, fieldRevertsByEmployee };
}
