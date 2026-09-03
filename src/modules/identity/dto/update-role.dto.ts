import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { RoleStatus } from '../entities/role-status.enum';

/** `PATCH /v1/roles/:id` body - same fields as `CreateRoleDto`, but `name` is also optional (a patch, not a full replace). */
export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(RoleStatus)
  status?: RoleStatus;

  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
