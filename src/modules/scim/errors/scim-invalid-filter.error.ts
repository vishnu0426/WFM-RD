import { DomainError } from '../../../common/errors/domain-error';

/**
 * RFC 7644 §3.4.2.2's filter grammar is large (and/or/not, complex
 * attributes, `pr`/`co`/`sw` operators, ...). This platform supports only
 * `attribute eq "value"` - the single filter shape every mainstream SCIM
 * client (Okta, Entra ID) actually sends for `userName eq`/`externalId eq`
 * lookups, which is what user/group provisioning is built around - see
 * `parseScimFilter`'s own doc comment.
 */
export class ScimInvalidFilterError extends DomainError {
  readonly code = 'SCIM_INVALID_FILTER';

  constructor(filter: string) {
    super(`Unsupported SCIM filter: "${filter}". Only "attribute eq \\"value\\"" is supported.`);
  }
}
