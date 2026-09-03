import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { EmployeeSkill } from '../entities/employee-skill.entity';

@Injectable()
export class EmployeeSkillsRepository extends TenantScopedRepository<EmployeeSkill> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, EmployeeSkill, tenantContext);
  }

  async findForEmployee(employeeId: string): Promise<EmployeeSkill[]> {
    return this.find({ where: { employeeId } as never });
  }

  async findOneFor(employeeId: string, skillId: string): Promise<EmployeeSkill | null> {
    return this.findOne({ where: { employeeId, skillId } as never });
  }

  /**
   * §3.3's `GetEmployeeSkillMatrix` data-layer query - every `EmployeeSkill`
   * row for the given employees, i.e. exactly the sparse (employee, skill)
   * pairs that exist, not a dense matrix with empty cells for the far more
   * common "employee doesn't have this skill" case.
   */
  async findForEmployees(employeeIds: string[]): Promise<EmployeeSkill[]> {
    if (employeeIds.length === 0) {
      return [];
    }
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) =>
      manager
        .getRepository(EmployeeSkill)
        .createQueryBuilder('es')
        .where('es.tenant_id = :tenantId', { tenantId })
        .andWhere('es.employee_id = ANY(:employeeIds)', { employeeIds })
        .getMany(),
    );
  }

  /**
   * ADR-0017: the nightly decay job's actual math, done as one bulk UPDATE
   * per batch of employee ids rather than N row-by-row updates.
   * `decay_score = exp(-ln(2)/halfLifeDays * daysSinceAnchor)`, where the
   * anchor is `last_scheduled_on_skill_at` if set, else `certified_date`,
   * else the row is left untouched (no anchor to decay from - a skill
   * that's never been scheduled or certified has nothing to measure
   * "staleness" against yet). Clamped to `[0, 1]` to match the column's own
   * `CHECK` constraint (Phase 1) even though the formula's range is
   * already `(0, 1]` in practice - defense in depth against float edge cases.
   */
  async applyDecayForEmployees(employeeIds: string[], halfLifeDays: number): Promise<void> {
    if (employeeIds.length === 0) {
      return;
    }
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    await withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) =>
      manager.query(
        `
        UPDATE org.employee_skills
        SET decay_score = LEAST(1, GREATEST(0,
          EXP(
            -LN(2) / $1 *
            (EXTRACT(EPOCH FROM (now() - COALESCE(last_scheduled_on_skill_at, certified_date::timestamptz))) / 86400)
          )
        ))
        WHERE tenant_id = $2 AND employee_id = ANY($3::uuid[])
          AND (last_scheduled_on_skill_at IS NOT NULL OR certified_date IS NOT NULL)
        `,
        [halfLifeDays, tenantId, employeeIds],
      ),
    );
  }

  /**
   * Data-layer primitive behind `skillsExpiringSoon(withinDays)` (GraphQL)
   * and `GET /v1/skills/expiring` (§3.2 - "paginated, tenant-scoped").
   */
  async findExpiringWithin(
    days: number,
    pagination: { limit: number; offset: number } = { limit: 50, offset: 0 },
  ): Promise<EmployeeSkill[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) =>
      manager
        .getRepository(EmployeeSkill)
        .createQueryBuilder('es')
        .where('es.tenant_id = :tenantId', { tenantId })
        .andWhere('es.expiry_date IS NOT NULL')
        .andWhere('es.expiry_date <= (now() + make_interval(days => :days))::date', { days })
        .orderBy('es.expiry_date', 'ASC')
        .limit(pagination.limit)
        .offset(pagination.offset)
        .getMany(),
    );
  }
}
