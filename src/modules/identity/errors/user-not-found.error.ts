import { NotFoundError } from '../../../common/errors/not-found.error';

export class UserNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('User', id);
  }
}
