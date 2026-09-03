import { NotFoundError } from '../../../common/errors/not-found.error';

export class TenantNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('Tenant', id);
  }
}
