/** Base class for every application-thrown error in this service, mirroring the root app's `src/common/errors/domain-error.ts`. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
