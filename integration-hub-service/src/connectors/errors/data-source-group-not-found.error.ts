import { DomainError } from '../../common/errors/domain-error';

export class DataSourceGroupNotFoundError extends DomainError {
  constructor(id: string) {
    super('DATA_SOURCE_GROUP_NOT_FOUND', `No DataSourceGroup found with id "${id}" for this tenant.`);
  }
}
