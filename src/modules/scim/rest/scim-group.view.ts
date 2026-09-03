import { Role } from '../../identity/entities/role.entity';
import { User } from '../../identity/entities/user.entity';

export interface ScimGroupView {
  schemas: string[];
  id: string;
  displayName: string;
  members: { value: string; display: string }[];
  meta: { resourceType: 'Group'; created: string; lastModified: string; location: string };
}

export function toScimGroupView(role: Role, members: User[]): ScimGroupView {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: role.id,
    displayName: role.name,
    members: members.map((m) => ({ value: m.id, display: m.email })),
    meta: {
      resourceType: 'Group',
      created: role.createdAt.toISOString(),
      lastModified: role.updatedAt.toISOString(),
      location: `/scim/v2/Groups/${role.id}`,
    },
  };
}
