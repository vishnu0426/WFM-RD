import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUrl, ValidateNested } from 'class-validator';
import { AttributeMappingDto } from './attribute-mapping.dto';

/** Protocol is immutable after creation - changing SAML<->OIDC is a new provider, not an edit. */
export class UpdateIdentityProviderDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsUrl({ require_tld: false })
  oidcDiscoveryUrl?: string;

  @IsOptional()
  @IsString()
  oidcClientId?: string;

  @IsOptional()
  @IsString()
  oidcClientSecret?: string;

  @IsOptional()
  @IsString()
  samlEntityId?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  samlSsoUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  samlSloUrl?: string;

  @IsOptional()
  @IsString()
  samlCertificate?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AttributeMappingDto)
  attributeMapping?: AttributeMappingDto;
}
