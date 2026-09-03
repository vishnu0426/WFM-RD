import { getValidAccessToken } from '@/auth/tokenGateway';

/**
 * Thin fetch wrapper for calling each owning module's existing REST/GraphQL
 * API directly (docs/adr/0146) — there is no shared gateway to route
 * through. Tenant scoping uses the same trusted `X-Tenant-Id` header every
 * other backend-to-backend caller in this platform uses (see ADR-0014's
 * placeholder, inherited here rather than reinvented).
 *
 * Every call attaches `Authorization: Bearer <accessToken>` via
 * `tokenGateway` (docs/adr/0150) — including to scheduling-service, which
 * doesn't check it yet (same ADR-0014 gap), because that's the correct
 * client behavior once a real token exists, not a two-tier client design.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestContext {
  apiBaseUrl: string;
  tenantId: string;
  signal?: AbortSignal;
}

export async function apiGet<T>(
  path: string,
  query: Record<string, string>,
  context: RequestContext,
): Promise<T> {
  const url = new URL(path, context.apiBaseUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const accessToken = await getValidAccessToken();
  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Tenant-Id': context.tenantId,
      Authorization: `Bearer ${accessToken}`,
    },
    signal: context.signal,
  });

  if (!response.ok) {
    throw new ApiError(response.status, `${path} responded with ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  context: Omit<RequestContext, 'signal'> & { signal?: AbortSignal },
): Promise<T> {
  const url = new URL(path, context.apiBaseUrl);

  const accessToken = await getValidAccessToken();
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Tenant-Id': context.tenantId,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
    signal: context.signal,
  });

  if (!response.ok) {
    throw new ApiError(response.status, `${path} responded with ${response.status}`);
  }

  return (await response.json()) as T;
}

/**
 * `tenantId` is optional — platform-core's own `me` query (the only
 * caller before Phase 7) derives identity from the bearer token, no
 * trusted header needed. intraday-service's `agentLiveState` and
 * adherence-compliance-service's `adherenceScoreToday` (Module 11 Phase
 * 7, docs/adr/0156) use the same ADR-0014 `X-Tenant-Id` header-trust
 * every REST endpoint in this platform already uses — passing `tenantId`
 * is required for those, or `TenantContextService.requireTenantId()`
 * throws server-side.
 */
export async function graphqlRequest<T>(
  graphqlApiBaseUrl: string,
  query: string,
  variables?: Record<string, unknown>,
  tenantId?: string,
): Promise<T> {
  const accessToken = await getValidAccessToken();
  const response = await fetch(`${graphqlApiBaseUrl}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new ApiError(response.status, `GraphQL request responded with ${response.status}`);
  }

  const json = await response.json();
  if (json.errors?.length) {
    throw new ApiError(200, json.errors[0].message ?? 'GraphQL request returned errors.');
  }

  return json.data as T;
}
