import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AccessTokenClaims, RequestWithTokenClaims } from './access-token.guard';

/**
 * Not present in core's own copy of this guard trio - added here (ADR-0161,
 * own copy of the same decorator every other RBAC-gated service in this
 * platform carries) so a gated resolver can read the verified token's own
 * claims. Not currently used by any gated resolver's own logic, but kept
 * for parity with the upstream pattern and available the moment a future
 * gated mutation needs it (e.g. recording who requested a report).
 */
export const CurrentTokenClaims = createParamDecorator(
  (_: unknown, context: ExecutionContext): AccessTokenClaims | undefined => {
    const req = GqlExecutionContext.create(context).getContext<{ req: RequestWithTokenClaims }>().req;
    return req.tokenClaims;
  },
);
