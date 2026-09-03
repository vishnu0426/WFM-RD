import { IsIn, IsOptional, IsString } from 'class-validator';

/** RFC 7662 §2.1. */
export class IntrospectRequestDto {
  @IsString()
  token!: string;

  @IsOptional()
  @IsIn(['refresh_token', 'access_token'])
  token_type_hint?: 'refresh_token' | 'access_token';

  @IsOptional()
  @IsString()
  client_id?: string;

  @IsOptional()
  @IsString()
  client_secret?: string;
}
