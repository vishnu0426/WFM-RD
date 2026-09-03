import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { TokenService } from '../../modules/auth/services/token.service';
import { TokenRevocationService } from '../../modules/auth/services/token-revocation.service';
import { UserContextCacheService } from '../../modules/auth/services/user-context-cache.service';

interface ValidateTokenRequest {
  accessToken: string;
}

interface ValidateTokenResponse {
  valid: boolean;
  tenantId: string;
  userId: string;
  orgUnitId: string;
  roles: string[];
  permissions: string[];
  amr: string[];
  exp: number;
  errorCode: string;
}

interface GetUserContextRequest {
  tenantId: string;
  userId: string;
}

interface GetUserContextResponse {
  roles: string[];
  permissions: string[];
  orgUnitId: string;
}

/**
 * §3.3's `IdentityService`. `ValidateToken` never throws a gRPC error status
 * for an expired/invalid/revoked token - `valid: false` + `errorCode` is a
 * normal response, since "the token is bad" is an expected, high-frequency
 * outcome every caller must branch on, not an exceptional one.
 */
@Controller()
export class IdentityGrpcController {
  private readonly logger = new Logger(IdentityGrpcController.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly tokenService: TokenService,
    private readonly tokenRevocation: TokenRevocationService,
    private readonly userContextCache: UserContextCacheService,
  ) {}

  @GrpcMethod('IdentityService', 'ValidateToken')
  async validateToken(request: ValidateTokenRequest): Promise<ValidateTokenResponse> {
    const invalid = (errorCode: string): ValidateTokenResponse => ({
      valid: false,
      tenantId: '',
      userId: '',
      orgUnitId: '',
      roles: [],
      permissions: [],
      amr: [],
      exp: 0,
      errorCode,
    });

    let claims;
    try {
      claims = await this.tokenService.verifyAccessToken(request.accessToken);
    } catch (err) {
      this.logger.debug(`ValidateToken: verification failed - ${(err as Error).message}`);
      return invalid('OAUTH_INVALID_GRANT');
    }

    if (await this.tokenRevocation.isRevoked(claims.jti)) {
      return invalid('TOKEN_REVOKED');
    }

    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () => ({
      valid: true,
      tenantId: claims.tenant_id,
      userId: claims.sub,
      orgUnitId: claims.org_unit_id ?? '',
      roles: claims.roles,
      permissions: claims.permissions,
      amr: claims.amr,
      exp: claims.exp,
      errorCode: '',
    }));
  }

  @GrpcMethod('IdentityService', 'GetUserContext')
  async getUserContext(request: GetUserContextRequest): Promise<GetUserContextResponse> {
    return this.tenantContext.run({ tenantId: request.tenantId }, async () => {
      const context = await this.userContextCache.get(request.tenantId, request.userId);
      return { roles: context.roles, permissions: context.permissions, orgUnitId: context.orgUnitId ?? '' };
    });
  }
}
