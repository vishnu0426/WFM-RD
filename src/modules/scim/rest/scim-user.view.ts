import { User } from '../../identity/entities/user.entity';
import { UserStatus } from '../../identity/entities/user-status.enum';

/** RFC 7643 §4.1's core User schema - only the subset this platform round-trips. */
export interface ScimUserView {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: { givenName?: string; familyName?: string };
  emails: { value: string; primary: boolean }[];
  active: boolean;
  meta: { resourceType: 'User'; created: string; lastModified: string; location: string };
}

export function toScimUserView(user: User): ScimUserView {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: user.id,
    ...(user.externalIdpId ? { externalId: user.externalIdpId } : {}),
    userName: user.email,
    name: {
      ...(user.givenName ? { givenName: user.givenName } : {}),
      ...(user.familyName ? { familyName: user.familyName } : {}),
    },
    emails: [{ value: user.email, primary: true }],
    active: user.status === UserStatus.ACTIVE,
    meta: {
      resourceType: 'User',
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
      location: `/scim/v2/Users/${user.id}`,
    },
  };
}
