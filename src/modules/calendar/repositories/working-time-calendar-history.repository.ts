import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { WorkingTimeCalendarHistory } from '../entities/working-time-calendar-history.entity';

/**
 * GAP-07 fix (enterprise readiness audit, 2026-08-18). Read-only, trigger-
 * written only - see the entity's doc comment. Same shape as
 * `EmployeeHistoryRepository`/`OrgUnitHistoryRepository`.
 */
@Injectable()
export class WorkingTimeCalendarHistoryRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  private withScope<R>(work: Parameters<typeof withTenantTransaction<R>>[2]): Promise<R> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, work);
  }

  async findHistory(calendarId: string): Promise<WorkingTimeCalendarHistory[]> {
    return this.withScope((manager) =>
      manager
        .getRepository(WorkingTimeCalendarHistory)
        .find({ where: { calendarId } as never, order: { validFrom: 'ASC' } as never }),
    );
  }

  async findVersionAsOf(calendarId: string, asOf: Date): Promise<WorkingTimeCalendarHistory | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.withScope((manager) =>
      manager
        .getRepository(WorkingTimeCalendarHistory)
        .createQueryBuilder('h')
        .where('h.tenant_id = :tenantId', { tenantId })
        .andWhere('h.calendar_id = :calendarId', { calendarId })
        .andWhere('h.valid_from <= :asOf', { asOf })
        .andWhere('(h.valid_to IS NULL OR h.valid_to > :asOf)', { asOf })
        .getOne(),
    );
  }
}
