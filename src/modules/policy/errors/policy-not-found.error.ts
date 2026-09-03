import { NotFoundError } from '../../../common/errors/not-found.error';

export class PolicyNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('Policy', id);
  }
}
