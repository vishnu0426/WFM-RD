import { DomainError } from '../../../common/errors/domain-error';

/**
 * Thrown by `EmployeeAvatarController` when `req.file` is undefined after
 * `FileInterceptor` runs - either `fileFilter` rejected the upload (wrong
 * mimetype: only `image/png`/`image/jpeg`/`image/webp` are accepted) or no
 * file was attached at all. Raised as a `DomainError` rather than a bare
 * Nest `BadRequestException` so the response still goes through
 * `DomainErrorFilter`'s standard `{ error: { code, message, details } }`
 * envelope instead of Nest's default shape.
 */
export class InvalidAvatarFileError extends DomainError {
  readonly code = 'INVALID_AVATAR_FILE';

  constructor() {
    super('No valid avatar file was uploaded. Only image/png, image/jpeg, and image/webp are accepted (max 5MB).');
  }
}
