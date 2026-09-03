import { NotFoundError } from '../../../common/errors/not-found.error';

export class EmployeeNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('Employee', id);
  }
}
