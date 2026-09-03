import { NotFoundError } from '../../../common/errors/not-found.error';

export class EmploymentPolicyNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('EmploymentPolicy', id);
  }
}
