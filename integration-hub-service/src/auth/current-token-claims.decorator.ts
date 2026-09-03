import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AccessTokenClaims, RequestWithTokenClaims } from './access-token.guard';

/**
 * Not present in core's own copy of this guard trio - added here (§7
 * Phase 8, ADR-0145, own copy of ai-layer-service's identical decorator)
 * so a gated resolver can read the verified token's own claims. Not
 * currently used by any gated resolver's own logic (`createConnector`/
 * `createWebhookSubscription` don't record a `createdBy` field), but kept
 * for parity with the upstream pattern and available the moment a future
 * gated mutation needs it.
 */
export const CurrentTokenClaims = createParamDecorator(
  (_: unknown, context: ExecutionContext): AccessTokenClaims | undefined => {
    const req = GqlExecutionContext.create(context).getContext<{ req: RequestWithTokenClaims }>().req;
    return req.tokenClaims;
  },
);
