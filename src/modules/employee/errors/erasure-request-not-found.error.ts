import { NotFoundError } from '../../../common/errors/not-found.error';

export class ErasureRequestNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('ErasureRequest', id);
  }
}
