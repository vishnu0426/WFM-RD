import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { TenantStatus } from '../../tenant/entities/tenant-status.enum';
import { WorkingTimeCalendarsRepository } from '../../calendar/repositories/working-time-calendars.repository';
import { SkillDecayJobService } from './skill-decay-job.service';

/**
 * Nil UUID, not a real tenant - `core.tenants`' RLS policy (ADR-0007) grants
 * full cross-tenant read to `is_platform_admin` sessions regardless of
 * `current_tenant_id`, so this constant only exists to satisfy
 * `TenantContextService.run()`'s "must be a well-formed UUID" validation
 * (ADR-0002) for a session that has no *single* tenant to bind. Never used
 * for anything tenant-scoped - only for the one cross-tenant enumeration
 * query below.
 */
const SYSTEM_BATCH_CONTEXT_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** §5: "default 02:00 tenant-local time." Not itself tenant-configurable in this phase - see ADR-0017. */
const DECAY_JOB_LOCAL_HOUR = 2;

/**
 * §5's scheduling half of the nightly decay job - `SkillDecayJobService` is
 * the per-tenant, resumable unit of work; this class decides *which*
 * tenants should run *right now*, respecting each tenant's own local time
 * via `WorkingTimeCalendar.timezone` (§5: "respect the tenant's timezone,
 * don't run all tenants at one global UTC time"). See ADR-0017.
 */
@Injectable()
export class SkillDecaySchedulerService {
  private readonly logger = new Logger(SkillDecaySchedulerService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly workingTimeCalendarsRepository: WorkingTimeCalendarsRepository,
    private readonly skillDecayJobService: SkillDecayJobService,
  ) {}

  /**
   * Ticks every 15 minutes rather than once a day at a fixed UTC time,
   * specifically so it can catch each tenant's own local 02:00 as it rolls
   * around the globe. `runForTenant` is idempotent (ADR-0017), so ticking
   * for the same tenant multiple times within its hour-long window is
   * harmless - later ticks just see `status: completed` and no-op.
   */
  @Cron('*/15 * * * *')
  async tick(): Promise<void> {
    const activeTenants = await this.findActiveTenants();
    for (const tenant of activeTenants) {
      try {
        await this.runIfInWindow(tenant);
      } catch (err) {
        // One tenant's failure must never stop the tick from reaching the
        // rest - each tenant's own DecayJobRun row already records its
        // failure (SkillDecayJobService.runForTenant); this is just the
        // top-level "don't let one bad tenant wedge the whole scheduler" guard.
        this.logger.error(`Decay scheduler tick failed for tenant=${tenant.id}: ${(err as Error).message}`);
      }
    }
  }

  private async runIfInWindow(tenant: Tenant): Promise<void> {
    await this.tenantContext.run({ tenantId: tenant.id }, async () => {
      const calendar = await this.workingTimeCalendarsRepository.findTenantDefault();
      const zone = this.safeZone(calendar?.timezone);
      const localNow = this.toZonedParts(new Date(), zone);

      if (localNow.hour !== DECAY_JOB_LOCAL_HOUR) {
        return;
      }

      await this.skillDecayJobService.runForTenant(tenant.id, localNow.date);
    });
  }

  /** Falls back to UTC for a tenant with no default calendar, or an unparseable zone name. */
  private safeZone(timezone: string | undefined): string {
    if (!timezone) {
      return 'UTC';
    }
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
      return timezone;
    } catch {
      this.logger.warn(`Unrecognized WorkingTimeCalendar.timezone "${timezone}" - falling back to UTC.`);
      return 'UTC';
    }
  }

  private toZonedParts(date: Date, timeZone: string): { hour: number; date: string } {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour: '2-digit',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
    return { hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
  }

  private async findActiveTenants(): Promise<Tenant[]> {
    return withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) => manager.getRepository(Tenant).find({ where: { status: TenantStatus.ACTIVE } }),
    );
  }
}
