import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AccessTokenClaims, RequestWithTokenClaims } from './access-token.guard';

/**
 * Not present in core's own copy of this guard trio - added here so gated
 * resolvers can read the verified token's own claims (most commonly `sub`,
 * for a real authenticated `updatedBy`/`decidedBy`/interaction `userId`,
 * closing the "no identity gRPC call wired" gap every pre-RBAC phase's own
 * doc comment named). The tenant cross-check itself (`TenantTokenMatchGuard`,
 * docs/adr/0133) reads `tokenClaims` directly off the request, not through
 * this decorator - it runs as a guard, before any resolver method body
 * (and this decorator) ever executes.
 */
export const CurrentTokenClaims = createParamDecorator(
  (_: unknown, context: ExecutionContext): AccessTokenClaims | undefined => {
    const req = GqlExecutionContext.create(context).getContext<{ req: RequestWithTokenClaims }>().req;
    return req.tokenClaims;
  },
);
