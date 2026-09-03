import { NotFoundError } from '../../../common/errors/not-found.error';

export class EmployeeGroupNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('EmployeeGroup', id);
  }
}
