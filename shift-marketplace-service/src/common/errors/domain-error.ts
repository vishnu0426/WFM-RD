/**
 * Base class for typed application errors, own copy of
 * attendance-leave-service's/intraday-service's `domain-error.ts` (ADR-0039
 * precedent: each service owns its client/error primitives rather than
 * sharing one). `DomainErrorFilter` maps `code` to an HTTP status; anything
 * not a `DomainError` falls through to a generic 500.
 */
export abstract class DomainError extends Error {
  protected constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
