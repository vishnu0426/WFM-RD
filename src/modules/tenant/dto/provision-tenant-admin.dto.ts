import { IsEmail, IsOptional, IsString } from 'class-validator';

/** Same shape as `InviteUserDto` (`user-management.controller.ts`) — this endpoint's first-admin user gets created the identical way an ordinary invited user does, just inside a tenant the caller has no ambient session bound to. */
export class ProvisionTenantAdminDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  givenName?: string;

  @IsOptional()
  @IsString()
  familyName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  jobTitle?: string;
}
