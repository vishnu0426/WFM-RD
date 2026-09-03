import { Injectable } from '@nestjs/common';
import { EmployeesRepository } from '../repositories/employees.repository';
import { EmployeeNotFoundError } from '../errors/employee-not-found.error';
import { UserAlreadyLinkedError } from '../errors/user-already-linked.error';
import { Employee } from '../entities/employee.entity';
import { EmployeeStatus } from '../entities/employee-status.enum';
import { CreateEmployeeInput } from '../dto/create-employee.input';
import { UpdateEmployeeInput } from '../dto/update-employee.input';
import { EmployeeFilterInput, PaginationInput } from '../dto/employee-filter.input';
import { OrgUnitsService } from '../../org-unit/services/org-units.service';
import { SUBJECTS, EmployeeChangedSubType } from '../../eventing/subjects';
import { isUniqueViolation } from '../../../database/postgres-error-codes';
import { SystemLimitsPolicyService } from '../../policy/services/system-limits-policy.service';

@Injectable()
export class EmployeesService {
  constructor(
    private readonly employeesRepository: EmployeesRepository,
    private readonly orgUnitsService: OrgUnitsService,
    private readonly systemLimits: SystemLimitsPolicyService,
  ) {}

  async findById(id: string): Promise<Employee> {
    const employee = await this.employeesRepository.findById(id);
    if (!employee) {
      throw new EmployeeNotFoundError(id);
    }
    return employee;
  }

  async findMany(filter: EmployeeFilterInput, pagination: PaginationInput): Promise<Employee[]> {
    return this.employeesRepository.findMany(
      { orgUnitId: filter.orgUnitId, status: filter.status, employmentType: filter.employmentType },
      { limit: pagination.limit ?? 50, offset: pagination.offset ?? 0 },
    );
  }

  /** GAP-06 fix (User Management audit): `employees()` had a real `limit`/`offset` but no way to know how many pages exist. */
  async countMany(filter: EmployeeFilterInput): Promise<number> {
    return this.employeesRepository.countMany({ orgUnitId: filter.orgUnitId, status: filter.status, employmentType: filter.employmentType });
  }

  private buildEmployeeChangedEvent(eventType: EmployeeChangedSubType) {
    return (employee: Employee) => ({
      subject: SUBJECTS.EMPLOYEE_CHANGED,
      payload: {
        employeeId: employee.id,
        tenantId: employee.tenantId,
        eventType,
        orgUnitId: employee.orgUnitId,
        updatedAt: employee.updatedAt?.toISOString() ?? new Date().toISOString(),
      },
    });
  }

  /**
   * Validates `orgUnitId`/`managerEmployeeId` up front so a bad reference
   * surfaces as `OrgUnitNotFoundError`/`EmployeeNotFoundError` (a clean 404)
   * instead of a raw Postgres foreign-key-violation bubbling up as a 500 -
   * the composite FKs (ADR-0010) still enforce it either way; this just
   * gives the common case a better error shape. Writes the `EmployeeChanged`
   * (`created`) outbox event in the same transaction as the insert
   * (ADR-0019).
   */
  async create(input: CreateEmployeeInput): Promise<Employee> {
    const currentCount = await this.employeesRepository.count({});
    await this.systemLimits.assertWithinLimit('maxEmployees', currentCount);
    await this.orgUnitsService.findById(input.orgUnitId);
    if (input.managerEmployeeId) {
      await this.findById(input.managerEmployeeId);
    }
    return this.employeesRepository.createWithOutboxEvent(
      {
        userId: input.userId ?? null,
        orgUnitId: input.orgUnitId,
        employeeNumber: input.employeeNumber,
        employmentType: input.employmentType,
        contractHoursPerWeek: input.contractHoursPerWeek.toFixed(2),
        hireDate: input.hireDate,
        terminationDate: null,
        costCenter: input.costCenter ?? null,
        managerEmployeeId: input.managerEmployeeId ?? null,
        status: EmployeeStatus.PENDING_ONBOARDING,
        middleInitial: input.middleInitial ?? null,
        suffix: input.suffix ?? null,
        birthDate: input.birthDate ?? null,
        email: input.email ?? null,
        desktopMessagingUsername: input.desktopMessagingUsername ?? null,
        homePhone: input.homePhone ?? null,
        workPhone: input.workPhone ?? null,
        cellPhone: input.cellPhone ?? null,
        homeAddress: (input.homeAddress as Record<string, string | null> | null) ?? null,
        isSupervisor: input.isSupervisor ?? false,
        isTeamLead: input.isTeamLead ?? false,
        teamLeadEmployeeId: input.teamLeadEmployeeId ?? null,
        jobTitle: input.jobTitle ?? null,
        taxId: input.taxId ?? null,
        wageAmount: input.wageAmount !== undefined && input.wageAmount !== null ? input.wageAmount.toFixed(2) : null,
        rank: input.rank ?? null,
        avatarUrl: null,
      },
      this.buildEmployeeChangedEvent('created'),
    );
  }

  /**
   * Covers everything except org-unit/manager changes (`transfer` below
   * owns those - see `UpdateEmployeeInput`'s doc comment). Termination is
   * `status: TERMINATED`: if the caller doesn't supply `terminationDate`,
   * it defaults to today rather than being left null, since a terminated
   * employee with no termination date would be an inconsistent row no
   * query in this module expects. Event sub-type is `terminated` when the
   * status transitions there, `updated` otherwise (§4).
   */
  async update(id: string, input: UpdateEmployeeInput): Promise<Employee> {
    await this.findById(id); // clean EmployeeNotFoundError instead of updateWithOutboxEvent's raw findOneOrFail
    const partial: Partial<Employee> = {};
    if (input.employmentType !== undefined) {
      partial.employmentType = input.employmentType;
    }
    if (input.contractHoursPerWeek !== undefined) {
      partial.contractHoursPerWeek = input.contractHoursPerWeek.toFixed(2);
    }
    if (input.costCenter !== undefined) {
      partial.costCenter = input.costCenter;
    }
    if (input.status !== undefined) {
      partial.status = input.status;
    }
    if (input.status === EmployeeStatus.TERMINATED) {
      partial.terminationDate = input.terminationDate ?? new Date().toISOString().slice(0, 10);
    } else if (input.terminationDate !== undefined) {
      partial.terminationDate = input.terminationDate;
    }
    // ADR-0150: closes the userId -> Employee gap's link/unlink path.
    // `null` explicitly unlinks; `undefined` (field omitted) leaves the
    // existing value untouched.
    if (input.userId !== undefined) {
      partial.userId = input.userId;
    }
    if (input.middleInitial !== undefined) {
      partial.middleInitial = input.middleInitial;
    }
    if (input.suffix !== undefined) {
      partial.suffix = input.suffix;
    }
    if (input.birthDate !== undefined) {
      partial.birthDate = input.birthDate;
    }
    if (input.email !== undefined) {
      partial.email = input.email;
    }
    if (input.desktopMessagingUsername !== undefined) {
      partial.desktopMessagingUsername = input.desktopMessagingUsername;
    }
    if (input.homePhone !== undefined) {
      partial.homePhone = input.homePhone;
    }
    if (input.workPhone !== undefined) {
      partial.workPhone = input.workPhone;
    }
    if (input.cellPhone !== undefined) {
      partial.cellPhone = input.cellPhone;
    }
    if (input.homeAddress !== undefined) {
      partial.homeAddress = input.homeAddress as Record<string, string | null> | null;
    }
    if (input.isSupervisor !== undefined) {
      partial.isSupervisor = input.isSupervisor;
    }
    if (input.isTeamLead !== undefined) {
      partial.isTeamLead = input.isTeamLead;
    }
    if (input.teamLeadEmployeeId !== undefined) {
      partial.teamLeadEmployeeId = input.teamLeadEmployeeId;
    }
    if (input.jobTitle !== undefined) {
      partial.jobTitle = input.jobTitle;
    }
    if (input.taxId !== undefined) {
      partial.taxId = input.taxId;
    }
    if (input.wageAmount !== undefined) {
      partial.wageAmount = input.wageAmount !== null ? input.wageAmount.toFixed(2) : null;
    }
    if (input.rank !== undefined) {
      partial.rank = input.rank;
    }
    const eventType: EmployeeChangedSubType = input.status === EmployeeStatus.TERMINATED ? 'terminated' : 'updated';
    const effectiveAt = input.effectiveDate ? new Date(input.effectiveDate) : undefined;
    try {
      return await this.employeesRepository.updateWithOutboxEvent(
        id,
        partial,
        this.buildEmployeeChangedEvent(eventType),
        effectiveAt,
      );
    } catch (err) {
      if (input.userId && isUniqueViolation(err)) {
        throw new UserAlreadyLinkedError(input.userId);
      }
      throw err;
    }
  }

  /**
   * §3.1's dedicated `transferEmployee` mutation. `org.fn_employee_history_track`
   * (Phase 1) writes the `EmployeeHistory` version as a side effect of the
   * plain `org_unit_id`/`manager_employee_id` UPDATE below - nothing extra
   * to do here, matching §3.1's "must write an EmployeeHistory row, not just
   * update org_unit_id in place" requirement, which the trigger already
   * satisfies unconditionally. Event sub-type is always `transferred` (§4).
   */
  async transfer(
    employeeId: string,
    newOrgUnitId: string,
    newManagerEmployeeId?: string | null,
    effectiveDate?: string,
  ): Promise<Employee> {
    await this.findById(employeeId);
    await this.orgUnitsService.findById(newOrgUnitId);
    if (newManagerEmployeeId) {
      await this.findById(newManagerEmployeeId);
    }
    const partial: Partial<Employee> = { orgUnitId: newOrgUnitId };
    if (newManagerEmployeeId !== undefined) {
      partial.managerEmployeeId = newManagerEmployeeId;
    }
    return this.employeesRepository.updateWithOutboxEvent(
      employeeId,
      partial,
      this.buildEmployeeChangedEvent('transferred'),
      effectiveDate ? new Date(effectiveDate) : undefined,
    );
  }

  /** The one path that returns the real Tax ID — every other read exposes only `taxIdLastFour` (`maskTaxId()`). Callers must record an audit entry; this method just returns the value. */
  async revealTaxId(id: string): Promise<string | null> {
    const employee = await this.findById(id);
    return employee.taxId;
  }

  /**
   * Called by `EmployeeAvatarController` after it has already validated and
   * written the file to disk - this just persists the resulting public URL.
   * Deliberately skips the `EmployeeChanged` outbox event/history versioning
   * every other field-level write here goes through: an avatar is a display
   * artifact, not a modeled business change, the same "disclosed scope cut"
   * posture `1700000024000-EmployeeProfileDetails` already applies to
   * wage/rank not being tracked by `org.fn_employee_history_track()`.
   */
  async setAvatarUrl(id: string, avatarUrl: string): Promise<Employee> {
    await this.findById(id);
    await this.employeesRepository.update({ id } as never, { avatarUrl });
    return this.findById(id);
  }
}
