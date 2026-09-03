import { Injectable } from '@nestjs/common';
import { MarketplaceClaimConflictError } from '../errors/marketplace-claim-conflict.error';
import { MarketplaceClaimForwardFailedError } from '../errors/marketplace-claim-forward-failed.error';

export interface MarketplaceClaimRequest {
  tenantId: string;
  employeeId: string;
  marketplacePostId: string;
}

const CLAIM_MUTATION = `
  mutation ClaimOpenShift($postId: ID!) {
    claimOpenShift(postId: $postId) {
      claim { id status validationResult claimedAt }
      post { id status }
    }
  }
`;

const CONFLICT_CODES = new Set(['POST_ALREADY_BEING_CLAIMED', 'POST_NOT_OPEN', 'MARKETPLACE_POST_NOT_FOUND']);

interface GraphQlError {
  message: string;
  extensions?: { code?: string };
}

interface ClaimOpenShiftData {
  claimOpenShift: {
    claim: { id: string; status: string; validationResult: Record<string, unknown> | null; claimedAt: string };
    post: { id: string; status: string };
  };
}

/**
 * Calls shift-marketplace-service's real `claimOpenShift` GraphQL mutation
 * (`ClaimOpenShiftService.claim()`'s concurrency-safe Redis-lock +
 * guardrail flow, §2.2 rule 3) - GraphQL only, no REST equivalent exists.
 * No guard on the target: `X-Tenant-Id` + `X-Actor-Id` (the claimant's
 * employeeId - the mutation has no explicit employeeId argument at all),
 * no HMAC, no Bearer forwarding (docs/adr/0153).
 *
 * **Never branches on `response.ok`/status for control flow.** A
 * resolver-thrown domain error still comes back as HTTP 200 with a
 * GraphQL `errors[]` array (Apollo's default) - the only reliable signal
 * is the parsed body's `errors`/`data`, checked in that order.
 */
@Injectable()
export class MarketplaceClaimClient {
  private readonly baseUrl = process.env.SHIFT_MARKETPLACE_SERVICE_URL ?? 'http://localhost:8400';

  async claim(request: MarketplaceClaimRequest): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': request.tenantId,
          'X-Actor-Id': request.employeeId,
        },
        body: JSON.stringify({ query: CLAIM_MUTATION, variables: { postId: request.marketplacePostId } }),
      });
    } catch (err) {
      throw new MarketplaceClaimForwardFailedError(
        503,
        `shift-marketplace-service unreachable: ${(err as Error).message}`,
      );
    }

    const body = await this.safeJson(response);
    if (!body) {
      throw new MarketplaceClaimForwardFailedError(response.status, `HTTP ${response.status}: unreadable body`);
    }

    if (body.errors?.length) {
      const [firstError] = body.errors;
      const code = firstError.extensions?.code;
      if (code && CONFLICT_CODES.has(code)) {
        throw new MarketplaceClaimConflictError(code, firstError.message);
      }
      throw new MarketplaceClaimForwardFailedError(response.status, firstError.message);
    }

    const claim = body.data?.claimOpenShift?.claim;
    if (claim?.status === 'rejected') {
      const reason =
        (claim.validationResult?.violations as string[] | undefined)?.join(', ') ||
        (claim.validationResult?.reason as string | undefined) ||
        'The shift is no longer available to claim.';
      throw new MarketplaceClaimConflictError('CLAIM_REJECTED', reason);
    }
  }

  private async safeJson(response: Response): Promise<{ errors?: GraphQlError[]; data?: ClaimOpenShiftData } | null> {
    try {
      return (await response.json()) as { errors?: GraphQlError[]; data?: ClaimOpenShiftData };
    } catch {
      return null;
    }
  }
}
