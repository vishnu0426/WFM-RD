import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** `POST /v1/intraday/ingestion-credentials` body. */
export class CreateIngestionCredentialDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label?: string;
}
