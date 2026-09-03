import { Injectable } from '@nestjs/common';
import { OrgUnitInteractionSettingsRepository } from '../repositories/org-unit-interaction-settings.repository';
import { OrgUnitInteractionSettings } from '../entities/org-unit-interaction-settings.entity';
import { UpsertOrgUnitInteractionSettingsInput } from '../dto/upsert-org-unit-interaction-settings.input';
import { OrgUnitsService } from '../../org-unit/services/org-units.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';

/** Resolved shape `resolveEffective` returns — a real row, or a synthetic platform-default fallback when no ancestor has ever been configured. */
export interface EffectiveInteractionSettings {
  orgUnitId: string;
  isConfigured: boolean;
  resolvedFromOrgUnitId: string | null;
  inheritFromParent: boolean;
  systemDefined: boolean;
  audioRecordingPercentage: string | null;
  videoRecordingPercentage: string | null;
  screenRecordingPercentage: string | null;
  inboxUrl: string | null;
  conditionalCustomDataJson: string | null;
  updatedAt: string | null;
}

const PLATFORM_DEFAULT = {
  systemDefined: true,
  audioRecordingPercentage: null,
  videoRecordingPercentage: null,
  screenRecordingPercentage: null,
  inboxUrl: null,
  conditionalCustomData: null,
};

/** GAP-03 fix (User Management audit) — see `OrgUnitInteractionSettings`'s own doc comment for what this closes and what it deliberately doesn't (no telephony integration exists to act on these values). */
@Injectable()
export class OrgUnitInteractionSettingsService {
  constructor(
    private readonly repository: OrgUnitInteractionSettingsRepository,
    private readonly orgUnitsService: OrgUnitsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async upsertForOrgUnit(input: UpsertOrgUnitInteractionSettingsInput): Promise<OrgUnitInteractionSettings> {
    await this.orgUnitsService.findById(input.orgUnitId); // throws OrgUnitNotFoundError if missing/cross-tenant
    const actorId = this.tenantContext.getStore()?.actorId ?? null;
    const existing = await this.repository.findForOrgUnit(input.orgUnitId);

    let conditionalCustomData: Record<string, unknown> | null | undefined;
    if (input.conditionalCustomDataJson !== undefined) {
      conditionalCustomData = input.conditionalCustomDataJson === null ? null : (JSON.parse(input.conditionalCustomDataJson) as Record<string, unknown>);
    }

    const fields: Partial<OrgUnitInteractionSettings> = {
      inheritFromParent: input.inheritFromParent ?? existing?.inheritFromParent ?? true,
      systemDefined: input.systemDefined ?? existing?.systemDefined ?? true,
      audioRecordingPercentage: input.audioRecordingPercentage != null ? String(input.audioRecordingPercentage) : input.audioRecordingPercentage === null ? null : (existing?.audioRecordingPercentage ?? null),
      videoRecordingPercentage: input.videoRecordingPercentage != null ? String(input.videoRecordingPercentage) : input.videoRecordingPercentage === null ? null : (existing?.videoRecordingPercentage ?? null),
      screenRecordingPercentage: input.screenRecordingPercentage != null ? String(input.screenRecordingPercentage) : input.screenRecordingPercentage === null ? null : (existing?.screenRecordingPercentage ?? null),
      inboxUrl: input.inboxUrl !== undefined ? input.inboxUrl : (existing?.inboxUrl ?? null),
      conditionalCustomData: conditionalCustomData !== undefined ? conditionalCustomData : (existing?.conditionalCustomData ?? null),
      updatedBy: actorId,
    };

    if (existing) {
      await this.repository.update({ orgUnitId: input.orgUnitId } as never, fields as never);
    } else {
      await this.repository.save({ orgUnitId: input.orgUnitId, ...fields } as OrgUnitInteractionSettings);
    }
    return (await this.repository.findForOrgUnit(input.orgUnitId))!;
  }

  /**
   * Walks up `parentOrgUnitId` while the current unit either has no row or
   * has `inheritFromParent: true`, returning the first concrete
   * (non-inheriting) row found. A tenant-wide cap on ~50 hops is a
   * corruption guard against an accidental parent-id cycle, not a real
   * organizational depth this platform expects.
   */
  async resolveEffective(orgUnitId: string): Promise<EffectiveInteractionSettings> {
    let currentId: string | null = orgUnitId;
    for (let hop = 0; currentId && hop < 50; hop += 1) {
      const row = await this.repository.findForOrgUnit(currentId);
      if (row && !row.inheritFromParent) {
        return this.toEffective(orgUnitId, row, true);
      }
      const orgUnit = await this.orgUnitsService.findById(currentId);
      currentId = orgUnit.parentOrgUnitId;
    }
    return {
      orgUnitId,
      isConfigured: false,
      resolvedFromOrgUnitId: null,
      inheritFromParent: true,
      ...PLATFORM_DEFAULT,
      conditionalCustomDataJson: null,
      updatedAt: null,
    };
  }

  private toEffective(orgUnitId: string, row: OrgUnitInteractionSettings, isConfigured: boolean): EffectiveInteractionSettings {
    return {
      orgUnitId,
      isConfigured,
      resolvedFromOrgUnitId: row.orgUnitId,
      inheritFromParent: row.inheritFromParent,
      systemDefined: row.systemDefined,
      audioRecordingPercentage: row.audioRecordingPercentage,
      videoRecordingPercentage: row.videoRecordingPercentage,
      screenRecordingPercentage: row.screenRecordingPercentage,
      inboxUrl: row.inboxUrl,
      conditionalCustomDataJson: row.conditionalCustomData ? JSON.stringify(row.conditionalCustomData) : null,
      updatedAt: row.updatedAt?.toISOString() ?? null,
    };
  }
}
