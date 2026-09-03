import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';

class ScimNameDto {
  @IsOptional()
  @IsString()
  givenName?: string;

  @IsOptional()
  @IsString()
  familyName?: string;
}

/** RFC 7643 §4.1's core User schema - write side (`POST`/`PUT`). `schemas` is accepted but ignored (single fixed core schema). */
export class ScimUserWriteDto {
  @IsString()
  userName!: string;

  @IsOptional()
  @IsString()
  externalId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScimNameDto)
  name?: ScimNameDto;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
