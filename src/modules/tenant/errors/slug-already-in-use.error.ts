import { DomainError } from '../../../common/errors/domain-error';

/** Platform Admin onboarding's Company Information step - `slug` is the one globally-unique (not per-tenant) tenant field, checked before insert since `uq_tenants_slug` would otherwise surface as an opaque Postgres unique-violation. */
export class SlugAlreadyInUseError extends DomainError {
  readonly code = 'SLUG_ALREADY_IN_USE';

  constructor(slug: string) {
    super(`A tenant with slug "${slug}" already exists.`, { slug });
  }
}
