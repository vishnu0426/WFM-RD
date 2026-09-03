import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

class ScimGroupMemberRefDto {
  @IsString()
  value!: string; // the SCIM User's `id` (= our User.id)
}

/** RFC 7643 §4.2's core Group schema - write side. */
export class ScimGroupWriteDto {
  @IsString()
  displayName!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScimGroupMemberRefDto)
  members?: ScimGroupMemberRefDto[];
}
