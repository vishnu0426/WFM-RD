import { Injectable } from '@nestjs/common';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { User } from '../../identity/entities/user.entity';
import { UserStatus } from '../../identity/entities/user-status.enum';
import { RefreshTokenService } from '../../auth/services/refresh-token.service';
import { ScimUserWriteDto } from '../dto/scim-user-write.dto';
import { ScimPatchOperationDto } from '../dto/scim-patch-request.dto';
import { parseScimFilter } from '../filter/scim-filter-parser';
import { ScimResourceNotFoundError } from '../errors/scim-resource-not-found.error';

const FILTER_ATTRIBUTE_TO_COLUMN: Record<string, keyof User> = {
  username: 'email',
  externalid: 'externalIdpId',
};

@Injectable()
export class ScimUsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async list(
    filter: string | undefined,
    startIndex: number,
    count: number,
  ): Promise<{ resources: User[]; total: number }> {
    const parsed = parseScimFilter(filter);
    const where = parsed ? this.filterToWhere(parsed.attribute, parsed.value) : {};

    const [resources, total] = await Promise.all([
      this.usersRepository.find({ where: where as never, skip: Math.max(0, startIndex - 1), take: count }),
      this.usersRepository.count({ where: where as never }),
    ]);
    return { resources, total };
  }

  async getOrFail(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } as never });
    if (!user) {
      throw new ScimResourceNotFoundError('User', id);
    }
    return user;
  }

  async create(tenantId: string, dto: ScimUserWriteDto): Promise<User> {
    return this.usersRepository.save({
      tenantId,
      email: dto.userName,
      externalIdpId: dto.externalId ?? null,
      givenName: dto.name?.givenName ?? null,
      familyName: dto.name?.familyName ?? null,
      status: dto.active === false ? UserStatus.DISABLED : UserStatus.ACTIVE,
      mfaEnabled: false,
    } as never);
  }

  async replace(id: string, dto: ScimUserWriteDto): Promise<User> {
    const existing = await this.getOrFail(id);
    const wasActive = existing.status === UserStatus.ACTIVE;
    const nowActive = dto.active !== false;

    await this.usersRepository.update(
      { id } as never,
      {
        email: dto.userName,
        externalIdpId: dto.externalId ?? null,
        givenName: dto.name?.givenName ?? null,
        familyName: dto.name?.familyName ?? null,
        status: nowActive ? UserStatus.ACTIVE : UserStatus.DISABLED,
      } as never,
    );

    if (wasActive && !nowActive) {
      await this.forceRevokeSessions(id);
    }
    return this.getOrFail(id);
  }

  /**
   * §5.7: "a SCIM deprovisioning request for a user mid-session must force
   * session revocation." Supported operations (RFC 7644 §3.5.2's full
   * grammar is large - this is the subset every mainstream SCIM client
   * actually sends): `replace` on `active` (the deprovisioning case this
   * requirement exists for), `name.givenName`, `name.familyName`,
   * `userName`, and a path-less `replace` whose `value` is an object
   * merging several of the above at once (Entra ID's preferred shape for
   * simple attribute updates).
   */
  async applyPatch(id: string, operations: ScimPatchOperationDto[]): Promise<User> {
    const existing = await this.getOrFail(id);
    const patch: Partial<Pick<User, 'email' | 'givenName' | 'familyName' | 'status'>> = {};
    let deactivating = false;

    for (const operation of operations) {
      if (operation.op.toLowerCase() !== 'replace') {
        continue; // add/remove have no defined meaning for User's scalar attributes in this subset.
      }
      if (!operation.path && typeof operation.value === 'object' && operation.value !== null) {
        this.mergePathlessReplace(patch, operation.value as Record<string, unknown>, () => (deactivating = true));
        continue;
      }
      this.applyPathedReplace(patch, operation.path, operation.value, () => (deactivating = true));
    }

    if (Object.keys(patch).length > 0) {
      await this.usersRepository.update({ id } as never, patch as never);
    }
    if (deactivating && existing.status === UserStatus.ACTIVE) {
      await this.forceRevokeSessions(id);
    }
    return this.getOrFail(id);
  }

  /** DELETE maps to deactivation, never a hard delete (§2.1: no destructive SCIM operation on this platform's system of record). */
  async deactivate(id: string): Promise<void> {
    const existing = await this.getOrFail(id);
    await this.usersRepository.update({ id } as never, { status: UserStatus.DISABLED } as never);
    if (existing.status === UserStatus.ACTIVE) {
      await this.forceRevokeSessions(id);
    }
  }

  private async forceRevokeSessions(userId: string): Promise<void> {
    await this.refreshTokens.revokeAllSessionsForUser(userId, 'scim_deprovisioned');
  }

  private mergePathlessReplace(
    patch: Partial<Pick<User, 'email' | 'givenName' | 'familyName' | 'status'>>,
    value: Record<string, unknown>,
    onDeactivate: () => void,
  ): void {
    if (typeof value.active === 'boolean') {
      patch.status = value.active ? UserStatus.ACTIVE : UserStatus.DISABLED;
      if (!value.active) {
        onDeactivate();
      }
    }
    if (typeof value.userName === 'string') {
      patch.email = value.userName;
    }
    const name = value.name as { givenName?: string; familyName?: string } | undefined;
    if (name?.givenName) {
      patch.givenName = name.givenName;
    }
    if (name?.familyName) {
      patch.familyName = name.familyName;
    }
  }

  private applyPathedReplace(
    patch: Partial<Pick<User, 'email' | 'givenName' | 'familyName' | 'status'>>,
    path: string | undefined,
    value: unknown,
    onDeactivate: () => void,
  ): void {
    switch (path) {
      case 'active':
        patch.status = value === true ? UserStatus.ACTIVE : UserStatus.DISABLED;
        if (value !== true) {
          onDeactivate();
        }
        break;
      case 'userName':
        if (typeof value === 'string') {
          patch.email = value;
        }
        break;
      case 'name.givenName':
        if (typeof value === 'string') {
          patch.givenName = value;
        }
        break;
      case 'name.familyName':
        if (typeof value === 'string') {
          patch.familyName = value;
        }
        break;
      default:
        break; // Unsupported path - ignored, not an error (RFC 7644 clients tolerate no-ops for attributes an SP doesn't manage).
    }
  }

  private filterToWhere(attribute: string, value: string): Partial<Record<keyof User, string>> {
    const column = FILTER_ATTRIBUTE_TO_COLUMN[attribute.toLowerCase()];
    if (!column) {
      return {};
    }
    return { [column]: value };
  }
}
