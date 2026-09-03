import { NotFoundError } from '../../../common/errors/not-found.error';

export class RoleNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('Role', id);
  }
}
