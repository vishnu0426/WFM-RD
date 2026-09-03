import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, ValidateNested } from 'class-validator';
import { IdentityProviderProtocol } from '../entities/identity-provider-protocol.enum';
import { AttributeMappingDto } from './attribute-mapping.dto';

/**
 * §5.5's `TenantIdentityProvider` create shape. OIDC vs. SAML field
 * requirements aren't expressed declaratively here (class-validator's
 * `@ValidateIf` per protocol is workable but the entity's own
 * `validateProtocolFields` `@BeforeInsert` hook already enforces this - see
 * that entity's doc comment - so this DTO only validates each field's own
 * shape, not the cross-field protocol requirement, to avoid enforcing the
 * same rule twice in two different ways that could drift apart).
 */
export class CreateIdentityProviderDto {
  @IsString()
  name!: string;

  @IsIn(Object.values(IdentityProviderProtocol))
  protocol!: IdentityProviderProtocol;

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
