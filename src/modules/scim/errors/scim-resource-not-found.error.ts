import { NotFoundError } from '../../../common/errors/not-found.error';

export class ScimResourceNotFoundError extends NotFoundError {
  constructor(resourceType: 'User' | 'Group', id: string) {
    super(resourceType, id);
  }
}
