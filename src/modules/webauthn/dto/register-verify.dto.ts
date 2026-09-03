import { IsObject, IsOptional, IsString } from 'class-validator';

/**
 * `response` is the browser's `RegistrationResponseJSON` (from
 * `@simplewebauthn/browser`'s `startRegistration()`) - a deeply-nested,
 * client-library-generated shape not worth re-declaring field-by-field with
 * class-validator; `WebAuthnService.verifyRegistration` (via
 * `@simplewebauthn/server`) is the actual validator for its contents.
 */
export class RegisterVerifyDto {
  @IsString()
  challengeId!: string;

  @IsObject()
  response!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  deviceName?: string;
}
