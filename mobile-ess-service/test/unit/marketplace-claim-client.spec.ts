import { MarketplaceClaimConflictError } from '../../src/mobile-sync/errors/marketplace-claim-conflict.error';
import { MarketplaceClaimForwardFailedError } from '../../src/mobile-sync/errors/marketplace-claim-forward-failed.error';
import { MarketplaceClaimClient } from '../../src/mobile-sync/providers/marketplace-claim-client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('MarketplaceClaimClient', () => {
  const request = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    employeeId: '22222222-2222-4222-8222-222222222222',
    marketplacePostId: '55555555-5555-4555-8555-555555555555',
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends X-Tenant-Id and X-Actor-Id headers, never a Bearer token or HMAC signature', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        jsonResponse(200, { data: { claimOpenShift: { claim: { status: 'approved' }, post: { status: 'claimed' } } } }),
      );
    const client = new MarketplaceClaimClient();

    await client.claim(request);

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Tenant-Id']).toBe(request.tenantId);
    expect(headers['X-Actor-Id']).toBe(request.employeeId);
    expect(headers.Authorization).toBeUndefined();
    expect(headers['x-agno-webhook-signature']).toBeUndefined();
  });

  it('resolves successfully when claim.status is approved or pending_approval', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        data: { claimOpenShift: { claim: { status: 'pending_approval' }, post: { status: 'claimed' } } },
      }),
    );
    const client = new MarketplaceClaimClient();

    await expect(client.claim(request)).resolves.toBeUndefined();
  });

  it('HTTP 200 with GraphQL errors[] still maps a conflict code to MarketplaceClaimConflictError - never trusts response.ok alone', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        errors: [
          {
            message: 'Marketplace post was just claimed by someone else.',
            extensions: { code: 'POST_ALREADY_BEING_CLAIMED' },
          },
        ],
      }),
    );
    const client = new MarketplaceClaimClient();

    await expect(client.claim(request)).rejects.toThrow(MarketplaceClaimConflictError);
  });

  it('HTTP 200 with GraphQL errors[] maps an infra code to MarketplaceClaimForwardFailedError', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        errors: [{ message: 'Redis unreachable.', extensions: { code: 'MARKETPLACE_UNAVAILABLE' } }],
      }),
    );
    const client = new MarketplaceClaimClient();

    await expect(client.claim(request)).rejects.toThrow(MarketplaceClaimForwardFailedError);
  });

  it('HTTP 200 with NO errors[] but claim.status "rejected" is still a conflict - the success-body nuance', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        data: {
          claimOpenShift: {
            claim: { status: 'rejected', validationResult: { violations: ['not_eligible_for_org_unit'] } },
            post: { status: 'open' },
          },
        },
      }),
    );
    const client = new MarketplaceClaimClient();

    await expect(client.claim(request)).rejects.toThrow(MarketplaceClaimConflictError);
  });

  it('an unreadable/non-JSON body maps to MarketplaceClaimForwardFailedError', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));
    const client = new MarketplaceClaimClient();

    await expect(client.claim(request)).rejects.toThrow(MarketplaceClaimForwardFailedError);
  });

  it('a network-level failure maps to MarketplaceClaimForwardFailedError', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connection refused'));
    const client = new MarketplaceClaimClient();

    await expect(client.claim(request)).rejects.toThrow(MarketplaceClaimForwardFailedError);
  });
});
