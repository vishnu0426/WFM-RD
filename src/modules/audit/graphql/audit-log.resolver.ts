import { UseGuards } from '@nestjs/common';
import { Args, Context, GraphQLISODateTime, Int, Query, Resolver } from '@nestjs/graphql';
import { AuditLogGraphQLType } from './audit-log.type';
import { AuditActorType } from '../entities/audit-actor-type.enum';
import { AuditLogRepository } from '../repositories/audit-log.repository';
import { RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/** Phase 6 GraphQL BFF (ADR-0045) - read-only, delegates to `AuditLogRepository.findByTenant` (the same repository method `AuditLogController` uses). */
@Resolver(() => AuditLogGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class AuditLogResolver {
  constructor(private readonly auditLogRepository: AuditLogRepository) {}

  @Query(() => [AuditLogGraphQLType])
  @RequirePermissions('audit:read')
  async auditLog(
    @Context() context: { req: RequestWithTokenClaims },
    @Args('resourceType', { nullable: true }) resourceType?: string,
    @Args('resourceId', { nullable: true }) resourceId?: string,
    @Args('actorType', { type: () => AuditActorType, nullable: true }) actorType?: AuditActorType,
    @Args('before', { type: () => GraphQLISODateTime, nullable: true }) before?: Date,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<AuditLogGraphQLType[]> {
    const claims = context.req.tokenClaims!;
    return this.auditLogRepository.findByTenant(claims.tenant_id, {
      resourceType,
      resourceId,
      actorType,
      before,
      limit,
    });
  }
}
