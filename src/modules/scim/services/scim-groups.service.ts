import { Injectable } from '@nestjs/common';
import { RolesRepository } from '../../identity/repositories/roles.repository';
import { UserRolesRepository } from '../../identity/repositories/user-roles.repository';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { Role } from '../../identity/entities/role.entity';
import { User } from '../../identity/entities/user.entity';
import { ScimGroupWriteDto } from '../dto/scim-group-write.dto';
import { ScimPatchOperationDto } from '../dto/scim-patch-request.dto';
import { ScimResourceNotFoundError } from '../errors/scim-resource-not-found.error';

export interface ScimGroupRecord {
  role: Role;
  members: User[];
}

/**
 * §5.3's `/scim/v2/Groups`, mapped onto §2.1's `Role`/`UserRole`: one SCIM
 * Group = one tenant-scoped `Role` (system roles are never SCIM-visible -
 * `RolesRepository` only ever touches tenant-scoped rows, see its own doc
 * comment); group membership = a tenant-wide `UserRole` assignment
 * (`scopeOrgUnitId IS NULL` - a SCIM group has no concept of org-unit
 * scoping, so this mapping intentionally can't express a scoped role
 * assignment; those still exist, `/scim/v2/Groups` just doesn't surface them).
 */
@Injectable()
export class ScimGroupsService {
  constructor(
    private readonly rolesRepository: RolesRepository,
    private readonly userRolesRepository: UserRolesRepository,
    private readonly usersRepository: UsersRepository,
  ) {}

  async list(): Promise<ScimGroupRecord[]> {
    const roles = await this.rolesRepository.findAllForTenant();
    return Promise.all(roles.map(async (role) => ({ role, members: await this.membersOf(role.id) })));
  }

  async getOrFail(id: string): Promise<ScimGroupRecord> {
    const role = await this.rolesRepository.findById(id);
    if (!role) {
      throw new ScimResourceNotFoundError('Group', id);
    }
    return { role, members: await this.membersOf(id) };
  }

  async create(dto: ScimGroupWriteDto): Promise<ScimGroupRecord> {
    const role = await this.rolesRepository.create({ name: dto.displayName });
    await this.setMembers(
      role.id,
      (dto.members ?? []).map((m) => m.value),
    );
    return this.getOrFail(role.id);
  }

  async replace(id: string, dto: ScimGroupWriteDto): Promise<ScimGroupRecord> {
    await this.getOrFail(id);
    await this.rolesRepository.update(id, { name: dto.displayName });
    await this.setMembers(
      id,
      (dto.members ?? []).map((m) => m.value),
    );
    return this.getOrFail(id);
  }

  /** Supported: `add`/`remove` on `path: "members"`, `replace` on `displayName` or `members` (pathed or path-less object). */
  async applyPatch(id: string, operations: ScimPatchOperationDto[]): Promise<ScimGroupRecord> {
    await this.getOrFail(id);

    for (const operation of operations) {
      const op = operation.op.toLowerCase();
      if (operation.path === 'members' && op === 'add') {
        await this.addMembers(id, this.extractMemberIds(operation.value));
      } else if (operation.path === 'members' && op === 'remove') {
        await this.removeMembers(id, this.extractMemberIds(operation.value));
      } else if (operation.path === 'members' && op === 'replace') {
        await this.setMembers(id, this.extractMemberIds(operation.value));
      } else if (operation.path === 'displayName' && op === 'replace' && typeof operation.value === 'string') {
        await this.rolesRepository.update(id, { name: operation.value });
      } else if (
        !operation.path &&
        op === 'replace' &&
        typeof operation.value === 'object' &&
        operation.value !== null
      ) {
        const value = operation.value as { displayName?: string; members?: unknown };
        if (value.displayName) {
          await this.rolesRepository.update(id, { name: value.displayName });
        }
        if (value.members !== undefined) {
          await this.setMembers(id, this.extractMemberIds(value.members));
        }
      }
    }
    return this.getOrFail(id);
  }

  async delete(id: string): Promise<void> {
    await this.getOrFail(id);
    await this.rolesRepository.delete(id);
  }

  private extractMemberIds(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => (typeof entry === 'string' ? entry : (entry as { value?: string }).value))
      .filter((id): id is string => typeof id === 'string');
  }

  private async membersOf(roleId: string): Promise<User[]> {
    const assignments = await this.userRolesRepository.findTenantWideForRole(roleId);
    const users = await Promise.all(
      assignments.map((assignment) => this.usersRepository.findOne({ where: { id: assignment.userId } as never })),
    );
    return users.filter((user): user is User => user !== null);
  }

  private async addMembers(roleId: string, userIds: string[]): Promise<void> {
    const current = new Set((await this.userRolesRepository.findTenantWideForRole(roleId)).map((a) => a.userId));
    await Promise.all(
      userIds.filter((id) => !current.has(id)).map((userId) => this.userRolesRepository.addMember(userId, roleId)),
    );
  }

  private async removeMembers(roleId: string, userIds: string[]): Promise<void> {
    await Promise.all(userIds.map((userId) => this.userRolesRepository.removeMember(userId, roleId)));
  }

  private async setMembers(roleId: string, targetUserIds: string[]): Promise<void> {
    const current = await this.userRolesRepository.findTenantWideForRole(roleId);
    const currentIds = new Set(current.map((a) => a.userId));
    const targetIds = new Set(targetUserIds);
    await Promise.all([
      ...targetUserIds
        .filter((id) => !currentIds.has(id))
        .map((userId) => this.userRolesRepository.addMember(userId, roleId)),
      ...[...currentIds]
        .filter((id) => !targetIds.has(id))
        .map((userId) => this.userRolesRepository.removeMember(userId, roleId)),
    ]);
  }
}
