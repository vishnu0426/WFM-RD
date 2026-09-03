import { NotFoundError } from '../../../common/errors/not-found.error';

export class IdentityProviderNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('TenantIdentityProvider', id);
  }
}
