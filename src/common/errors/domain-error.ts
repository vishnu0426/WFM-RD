/**
 * Base class for every application-thrown error in this module. `code` is
 * the stable string this repo will map into the canonical error-code
 * registry (§3.4) once REST/GraphQL/gRPC surfaces exist (Phase 6) - defined
 * now so Phase 1's errors don't need renaming later.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  readonly details?: Record<string, unknown>;

  protected constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}
