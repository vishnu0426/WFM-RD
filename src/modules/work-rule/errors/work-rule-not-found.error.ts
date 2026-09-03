import { NotFoundError } from '../../../common/errors/not-found.error';

export class WorkRuleNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('WorkRule', id);
  }
}
