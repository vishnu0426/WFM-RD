import { Injectable } from '@nestjs/common';
import { OrgUnitsRepository } from '../repositories/org-units.repository';
import { OrgUnitNotFoundError } from '../errors/org-unit-not-found.error';
import { OrgUnit } from '../entities/org-unit.entity';
import { OrgUnitStatus } from '../entities/org-unit-status.enum';
import { CreateOrgUnitInput } from '../dto/create-org-unit.input';
import { UpdateOrgUnitInput } from '../dto/update-org-unit.input';
import { SystemLimitsPolicyService } from '../../policy/services/system-limits-policy.service';

@Injectable()
export class OrgUnitsService {
  constructor(
    private readonly orgUnitsRepository: OrgUnitsRepository,
    private readonly systemLimits: SystemLimitsPolicyService,
  ) {}

  async findById(id: string): Promise<OrgUnit> {
    const orgUnit = await this.orgUnitsRepository.findById(id);
    if (!orgUnit) {
      throw new OrgUnitNotFoundError(id);
    }
    return orgUnit;
  }

  /**
   * Tenant Monitoring onboarding checklist (internal CS tool): "has the
   * Organization step been done yet" derived from real data, not a stored
   * progress flag - a brand-new tenant's first org unit is always a root
   * (no parent), so a non-empty `findRoots()` is sufficient evidence,
   * without needing a dedicated count/exists query.
   */
  async hasAnyOrgUnits(): Promise<boolean> {
    const roots = await this.orgUnitsRepository.findRoots();
    return roots.length > 0;
  }

  /**
   * `tenantId` is intentionally not a parameter - `OrgUnitsRepository.save`
   * (via `TenantScopedRepository`) fills it in from the bound
   * `TenantContextService` context, the same guard every other write in
   * this module goes through. `org.fn_org_unit_set_path`/
   * `org.fn_org_unit_history_track` (Phase 1) handle path/history as a side
   * effect of the plain INSERT below - nothing extra to do here.
   */
  async create(input: CreateOrgUnitInput): Promise<OrgUnit> {
    const currentCount = await this.orgUnitsRepository.count({});
    await this.systemLimits.assertWithinLimit('maxOrgUnits', currentCount);
    return this.orgUnitsRepository.save({
      parentOrgUnitId: input.parentOrgUnitId ?? null,
      type: input.type,
      name: input.name,
      timezone: input.timezone,
      countryCode: input.countryCode,
      status: OrgUnitStatus.ACTIVE,
    } as OrgUnit);
  }

  /**
   * Covers rename, reparent, and archive (§2.2 rule 4's arbitrary-depth
   * reparenting and `status: ARCHIVED` both flow through the plain UPDATE
   * below) - `findById` first so a nonexistent/cross-tenant id surfaces as
   * `OrgUnitNotFoundError` rather than TypeORM's silent "0 rows affected."
   */
  async update(id: string, input: UpdateOrgUnitInput): Promise<OrgUnit> {
    await this.findById(id);
    const { effectiveDate, ...fields } = input;
    await this.orgUnitsRepository.updateWithEffectiveDate(
      id,
      fields as never,
      effectiveDate ? new Date(effectiveDate) : undefined,
    );
    return this.findById(id);
  }
}
