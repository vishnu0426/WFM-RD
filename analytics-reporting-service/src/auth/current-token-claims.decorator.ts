import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { AccessTokenClaims, RequestWithTokenClaims } from './access-token.guard';

/**
 * Not present in core's own copy of this guard trio - added here (ADR-0163,
 * own copy of the same decorator every other RBAC-gated service in this
 * platform carries) so a gated resolver/controller can read the verified
 * token's own claims - e.g. `DashboardResolver` sourcing actor identity
 * from `claims.sub` instead of the header-trusted `X-Actor-Id`.
 *
 * ADR-0164: widened to also work over REST (`AnalyticsExportsController`'s
 * own use), same GraphQL-vs-HTTP branch `AccessTokenGuard`'s own
 * `getRequest` helper already uses - the original copy only ever handled a
 * GraphQL execution context (fine while `DashboardResolver` was this
 * decorator's only caller), and would have read the wrong thing (or
 * thrown) applied to a plain HTTP request.
 */
export const CurrentTokenClaims = createParamDecorator(
  (_: unknown, context: ExecutionContext): AccessTokenClaims | undefined => {
    const req = getRequest(context);
    return req.tokenClaims;
  },
);

function getRequest(context: ExecutionContext): RequestWithTokenClaims {
  if (context.getType<GqlContextType>() === 'graphql') {
    return GqlExecutionContext.create(context).getContext<{ req: RequestWithTokenClaims }>().req;
  }
  return context.switchToHttp().getRequest<RequestWithTokenClaims>();
}
