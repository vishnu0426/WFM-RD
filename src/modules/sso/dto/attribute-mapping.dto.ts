import { IsOptional, IsString } from 'class-validator';

export class AttributeMappingDto {
  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  givenName?: string;

  @IsOptional()
  @IsString()
  familyName?: string;

  @IsOptional()
  @IsString()
  groups?: string;
}
