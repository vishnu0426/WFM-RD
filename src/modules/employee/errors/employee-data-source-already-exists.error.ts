import { DomainError } from '../../../common/errors/domain-error';

/** Thrown when `addEmployeeDataSource` would violate `uq_employee_data_sources_employee_source` — this employee already has a row for that data source; edit the existing row instead of adding a second one. */
export class EmployeeDataSourceAlreadyExistsError extends DomainError {
  readonly code = 'EMPLOYEE_DATA_SOURCE_ALREADY_EXISTS';

  constructor(employeeId: string, dataSource: string) {
    super(`Employee ${employeeId} already has a "${dataSource}" data source.`, { employeeId, dataSource });
  }
}
