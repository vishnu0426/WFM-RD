import { NotFoundError } from '../../../common/errors/not-found.error';

export class BulkImportJobNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('BulkImportJob', id);
  }
}
