import { NotFoundError } from '../../../common/errors/not-found.error';

export class EmployeeInteractionNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('EmployeeInteraction', id);
  }
}
