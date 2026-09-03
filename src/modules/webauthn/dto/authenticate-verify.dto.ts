import { IsObject, IsString } from 'class-validator';

/** `response` is the browser's `AuthenticationResponseJSON` - see `RegisterVerifyDto`'s doc comment for why it isn't field-validated here. */
export class AuthenticateVerifyDto {
  @IsString()
  client_id!: string;

  @IsString()
  challengeId!: string;

  @IsObject()
  response!: Record<string, unknown>;
}
