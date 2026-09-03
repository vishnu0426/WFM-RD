import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { EmployeeDataSourcesRepository } from '../repositories/employee-data-sources.repository';
import { EmployeeDataSource } from '../entities/employee-data-source.entity';
import { EmployeesService } from './employees.service';
import { CreateEmployeeDataSourceInput } from '../dto/create-employee-data-source.input';
import { UpdateEmployeeDataSourceInput } from '../dto/update-employee-data-source.input';
import { EmployeeDataSourceNotFoundError } from '../errors/employee-data-source-not-found.error';
import { EmployeeDataSourceAlreadyExistsError } from '../errors/employee-data-source-already-exists.error';
import { AgentIdentityAlreadyInUseError } from '../errors/agent-identity-already-in-use.error';
import { isUniqueViolation, constraintNameOf } from '../../../database/postgres-error-codes';

/**
 * Replaces the old single-column `Employee.agentId`/`extension`/
 * `dataSource` model - see `EmployeeDataSource`'s own doc comment for why.
 * Not partitioned like `Employee`, so `constraintNameOf` matches the exact
 * name declared in migration `1700000035000` rather than a substring.
 */
@Injectable()
export class EmployeeDataSourcesService {
  constructor(
    private readonly repository: EmployeeDataSourcesRepository,
    private readonly employeesService: EmployeesService,
  ) {}

  async findForEmployee(employeeId: string): Promise<EmployeeDataSource[]> {
    return this.repository.findForEmployee(employeeId);
  }

  async findForEmployees(employeeIds: string[]): Promise<EmployeeDataSource[]> {
    return this.repository.findForEmployees(employeeIds);
  }

  async create(input: CreateEmployeeDataSourceInput): Promise<EmployeeDataSource> {
    await this.employeesService.findById(input.employeeId);
    try {
      return await this.repository.save({
        id: uuidv4(),
        employeeId: input.employeeId,
        dataSource: input.dataSource,
        agentId: input.agentId ?? null,
        extension: input.extension ?? null,
      } as EmployeeDataSource);
    } catch (err) {
      if (isUniqueViolation(err) && constraintNameOf(err) === 'uq_employee_data_sources_employee_source') {
        throw new EmployeeDataSourceAlreadyExistsError(input.employeeId, input.dataSource);
      }
      this.translateAgentIdentityViolation(err, input.dataSource, input.agentId ?? null, input.extension ?? null);
      throw err;
    }
  }

  async update(input: UpdateEmployeeDataSourceInput): Promise<EmployeeDataSource> {
    const existing = await this.repository.findByIdOrNull(input.id);
    if (!existing) {
      throw new EmployeeDataSourceNotFoundError(input.id);
    }
    const patch: Partial<EmployeeDataSource> = {};
    if (input.agentId !== undefined) patch.agentId = input.agentId;
    if (input.extension !== undefined) patch.extension = input.extension;
    try {
      await this.repository.update({ id: input.id } as never, patch as never);
    } catch (err) {
      this.translateAgentIdentityViolation(
        err,
        existing.dataSource,
        input.agentId !== undefined ? input.agentId : existing.agentId,
        input.extension !== undefined ? input.extension : existing.extension,
      );
      throw err;
    }
    return (await this.repository.findByIdOrNull(input.id))!;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.repository.findByIdOrNull(id);
    if (!existing) {
      throw new EmployeeDataSourceNotFoundError(id);
    }
    await this.repository.delete({ id } as never);
  }

  /** Both unique indexes are `(tenant_id, data_source, <field>) WHERE <field> IS NOT NULL` — only relevant when the caller actually supplied that field. */
  private translateAgentIdentityViolation(err: unknown, dataSource: string, agentId: string | null, extension: string | null): void {
    if (!isUniqueViolation(err)) return;
    const constraint = constraintNameOf(err) ?? '';
    if (constraint === 'uq_employee_data_sources_agent_id' && agentId) {
      throw new AgentIdentityAlreadyInUseError('agentId', agentId, dataSource);
    }
    if (constraint === 'uq_employee_data_sources_extension' && extension) {
      throw new AgentIdentityAlreadyInUseError('extension', extension, dataSource);
    }
  }
}
