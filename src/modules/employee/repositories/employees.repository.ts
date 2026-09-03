import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { OutboxEventsRepository } from '../../eventing/repositories/outbox-events.repository';
import { Employee } from '../entities/employee.entity';

interface OutboxEventSpec {
  subject: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class EmployeesRepository extends TenantScopedRepository<Employee> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, Employee, tenantContext);
  }

  /**
   * `id` is generated client-side rather than relied upon via Postgres
   * RETURNING (same reasoning as `AuditLogRepository.record` - determinism
   * regardless of driver/version RETURNING behavior, doubly relevant here
   * since `Employee`'s PK is composite `(tenant_id, id)`, ADR-0010).
   * `tenantId` is omitted from the input type - `save()` (inherited from
   * `TenantScopedRepository`) fills it in from the bound tenant context.
   */
  async create(input: Omit<Employee, 'id' | 'createdAt' | 'updatedAt' | 'tenantId'>): Promise<Employee> {
    return this.save({ ...input, id: uuidv4() } as Employee);
  }

  /**
   * ADR-0019: the transactional-outbox counterpart to `create`/`update` -
   * the entity write and the `EmployeeChanged` outbox row commit in the
   * same transaction, or neither does. `buildEvent` receives the
   * post-write entity (so it can read the generated `id`) and returns the
   * event to record; both `EmployeesService.create` and
   * `.update`/`.transfer` use this same primitive with different event
   * sub-types (§4: created/updated/transferred/terminated), rather than
   * three near-duplicate transaction-handling methods.
   */
  async createWithOutboxEvent(
    input: Omit<Employee, 'id' | 'createdAt' | 'updatedAt' | 'tenantId'>,
    buildEvent: (employee: Employee) => OutboxEventSpec,
  ): Promise<Employee> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, async (manager) => {
      const saved = await manager.getRepository(Employee).save({ ...input, id: uuidv4(), tenantId } as Employee);
      const event = buildEvent(saved);
      await OutboxEventsRepository.insertWithinTransaction(manager, tenantId, event.subject, event.payload);
      return saved;
    });
  }

  /**
   * `effectiveAt` (GAP-07 fix, enterprise readiness audit, 2026-08-18):
   * when supplied, binds the session-local `app.effective_at` GUC for the
   * duration of this transaction so `org.fn_employee_history_track()`
   * versions the resulting `EmployeeHistory` row as of that timestamp
   * instead of `now()` - see `1700000017000`'s own doc comment for why
   * this is safe (an unset GUC resolves to exactly today's behavior).
   * Omitted (the default, every pre-existing caller) means "effective now,"
   * unchanged.
   */
  async updateWithOutboxEvent(
    id: string,
    partial: Partial<Employee>,
    buildEvent: (employee: Employee) => OutboxEventSpec,
    effectiveAt?: Date,
  ): Promise<Employee> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, async (manager) => {
      if (effectiveAt) {
        await manager.query('SELECT set_config($1, $2, true)', ['app.effective_at', effectiveAt.toISOString()]);
      }
      await manager.getRepository(Employee).update({ id, tenantId }, partial as never);
      const updated = await manager.getRepository(Employee).findOneOrFail({ where: { id, tenantId } as never });
      const event = buildEvent(updated);
      await OutboxEventsRepository.insertWithinTransaction(manager, tenantId, event.subject, event.payload);
      return updated;
    });
  }

  async findById(id: string): Promise<Employee | null> {
    return this.findOne({ where: { id } as never });
  }

  async findByEmployeeNumber(employeeNumber: string): Promise<Employee | null> {
    return this.findOne({ where: { employeeNumber } as never });
  }

  /**
   * Closes ADR-0150's `userId -> Employee` gap (the reverse direction of
   * the already-settable `Employee.userId` column). Returns a single row,
   * not a list - a new partial unique index on `(tenant_id, user_id)
   * WHERE user_id IS NOT NULL` (this same migration) guarantees at most
   * one `Employee` can hold a given `userId` going forward.
   */
  async findByUserId(userId: string): Promise<Employee | null> {
    return this.findOne({ where: { userId } as never });
  }

  async findByOrgUnit(orgUnitId: string): Promise<Employee[]> {
    return this.find({ where: { orgUnitId } as never });
  }

  async findDirectReports(managerEmployeeId: string): Promise<Employee[]> {
    return this.find({ where: { managerEmployeeId } as never });
  }

  /**
   * §3.3's `EmployeeService.GetEmployeeOrgUnits` data-layer query (docs/adr/0099) -
   * sparse (one entry per id that actually exists, same convention
   * `EmployeeSkillsRepository.findForEmployees` uses for
   * `GetEmployeeSkillMatrix`), not an error on an unknown id: the caller
   * (Module 08's rollup job) already knows which employee ids have real
   * event data: an id this returns nothing for is simply "no org unit
   * resolvable," not a fault.
   */
  async findByIds(employeeIds: string[]): Promise<Employee[]> {
    if (employeeIds.length === 0) {
      return [];
    }
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) =>
      manager
        .getRepository(Employee)
        .createQueryBuilder('employee')
        .where('employee.tenant_id = :tenantId', { tenantId })
        .andWhere('employee.id = ANY(:employeeIds)', { employeeIds })
        .getMany(),
    );
  }

  /** Data-layer primitive behind `employees(filter, pagination)` (§3.1, Phase 3). */
  async findMany(
    filter: { orgUnitId?: string; status?: string; employmentType?: string },
    pagination: { limit: number; offset: number },
  ): Promise<Employee[]> {
    return this.find({
      where: { ...filter } as never,
      take: pagination.limit,
      skip: pagination.offset,
      order: { employeeNumber: 'ASC' } as never,
    });
  }

  /** Same filter shape as `findMany` — backs `employeesCount`, GAP-06's pagination fix (User Management audit). */
  async countMany(filter: { orgUnitId?: string; status?: string; employmentType?: string }): Promise<number> {
    return this.count({ where: { ...filter } as never });
  }

  /**
   * Cursor-paginated employee ids ordered by `id` - the checkpoint-friendly
   * read behind the nightly decay job's resumable batch processing
   * (ADR-0017). Ordering by `id` (not `employeeNumber`) so the cursor is a
   * simple `id > :afterId` comparison with no secondary tie-break needed.
   */
  async findIdsPage(afterId: string | null, limit: number): Promise<string[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    const rows = await withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) => {
      const qb = manager
        .getRepository(Employee)
        .createQueryBuilder('employee')
        .select('employee.id', 'id')
        .where('employee.tenant_id = :tenantId', { tenantId })
        .orderBy('employee.id', 'ASC')
        .limit(limit);
      if (afterId) {
        qb.andWhere('employee.id > :afterId', { afterId });
      }
      return qb.getRawMany<{ id: string }>();
    });
    return rows.map((r) => r.id);
  }

  /**
   * §3.3's `EmployeeService.GetSchedulableEmployees` data-layer query, and
   * the hot path the §0.5 SLO (p99 < 100ms) is about - `status = 'active'`,
   * within the org unit, meeting the contract-hours floor, and (if any are
   * requested) holding *every* required skill. "Holding every required
   * skill" is a `HAVING COUNT(DISTINCT skill_id) = requiredSkillIds.length`
   * against `employee_skills` - a hard boolean gate, deliberately not
   * filtered by `decay_score` (§2.2 rule 3: decay is a solver-side soft
   * weight, never a hard has-skill/doesn't-have-skill filter here).
   * Cursor-paginated the same way `findIdsPage` is, for the gRPC server
   * stream (ADR-0021) to page through without an unbounded result set.
   */
  async findSchedulablePage(
    orgUnitId: string,
    requiredSkillIds: string[],
    minContractHoursPerWeek: number,
    afterId: string | null,
    limit: number,
  ): Promise<Employee[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) => {
      const qb = manager
        .getRepository(Employee)
        .createQueryBuilder('employee')
        .where('employee.tenant_id = :tenantId', { tenantId })
        .andWhere('employee.org_unit_id = :orgUnitId', { orgUnitId })
        .andWhere('employee.status = :status', { status: 'active' })
        .andWhere('employee.contract_hours_per_week >= :minHours', { minHours: minContractHoursPerWeek })
        .orderBy('employee.id', 'ASC')
        .limit(limit);

      if (afterId) {
        qb.andWhere('employee.id > :afterId', { afterId });
      }
      if (requiredSkillIds.length > 0) {
        qb.andWhere(
          `employee.id IN (
            SELECT es.employee_id FROM org.employee_skills es
            WHERE es.tenant_id = :tenantId AND es.skill_id = ANY(:skillIds)
            GROUP BY es.employee_id
            HAVING COUNT(DISTINCT es.skill_id) = :requiredSkillCount
          )`,
          { skillIds: requiredSkillIds, requiredSkillCount: requiredSkillIds.length },
        );
      }

      return qb.getMany();
    });
  }
}
