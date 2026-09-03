/**
 * Base class for typed application errors, mirrors intraday-service's
 * `src/common/errors/domain-error.ts`. `DomainErrorFilter` maps `code` to
 * an HTTP status; anything not a `DomainError` falls through to a generic
 * 500.
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
