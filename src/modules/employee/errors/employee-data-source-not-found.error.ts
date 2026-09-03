import { DomainError } from '../../../common/errors/domain-error';

export class EmployeeDataSourceNotFoundError extends DomainError {
  readonly code = 'EMPLOYEE_DATA_SOURCE_NOT_FOUND';

  constructor(id: string) {
    super(`No EmployeeDataSource exists with id ${id}.`, { id });
  }
}
