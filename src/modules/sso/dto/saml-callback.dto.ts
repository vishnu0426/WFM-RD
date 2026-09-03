import { IsOptional, IsString } from 'class-validator';

/** RFC-less: SAML 2.0 HTTP-POST binding's standard ACS form field names. */
export class SamlCallbackDto {
  @IsString()
  SAMLResponse!: string;

  @IsOptional()
  @IsString()
  RelayState?: string;
}
