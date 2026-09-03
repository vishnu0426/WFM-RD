import { graphqlRequest } from './client';

export interface Me {
  id: string;
  email: string;
  givenName: string | null;
  familyName: string | null;
}

const ME_QUERY = `query Me { me { id email givenName familyName } }`;

/** Platform-core's existing `me` query (`src/modules/identity/graphql/
 * user.resolver.ts`) — no employeeId field, no bridge to Employee
 * (docs/adr/0150). Used by the Profile screen for display only. */
export async function getMe(authApiBaseUrl: string): Promise<Me> {
  const data = await graphqlRequest<{ me: Me }>(authApiBaseUrl, ME_QUERY);
  return data.me;
}
