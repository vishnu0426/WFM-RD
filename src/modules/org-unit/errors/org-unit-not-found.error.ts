import { NotFoundError } from '../../../common/errors/not-found.error';

export class OrgUnitNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('OrgUnit', id);
  }
}
