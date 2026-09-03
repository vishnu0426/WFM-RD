import { DomainError } from '../../../common/errors/domain-error';

/** Any TCP-level failure, CSTA fault response, or unexpected frame while talking to an AES CSTA-XML link (ECMA-323 Annex J; see docs/adr on this adapter for exactly which parts are sourced from the public standard vs. best-effort). */
export class AvayaAuraApiError extends DomainError {
  constructor(cause: string) {
    super('AVAYA_AURA_API_ERROR', `Avaya Aura CSTA link failed: ${cause}`);
  }
}
