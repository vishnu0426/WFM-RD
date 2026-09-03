import { IsEmail, IsString } from 'class-validator';

/** `client_id` resolves the tenant the same way `AuthorizeRequestDto`'s does. */
export class AuthenticateOptionsRequestDto {
  @IsString()
  client_id!: string;

  @IsEmail()
  email!: string;
}
