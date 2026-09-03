import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Permission } from '../entities/permission.entity';

/**
 * `Permission` is global reference data (no `tenant_id`, no RLS - see the
 * entity's own doc comment), so this is a plain `DataSource` wrapper, not a
 * `TenantScopedRepository` - same posture as `SigningKeysRepository`
 * (ADR-0024) for the same structural reason. Read-only: the permission
 * catalog is deployment-managed (migrations/seed), not a tenant-facing
 * write surface - a tenant can bind existing permissions to its own roles
 * (`RolePermissionsRepository`) but cannot invent new `resource:action`
 * pairs through the API.
 */
@Injectable()
export class PermissionsRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findAll(): Promise<Permission[]> {
    return this.dataSource.getRepository(Permission).find({ order: { resource: 'ASC', action: 'ASC' } });
  }

  async findById(id: string): Promise<Permission | null> {
    return this.dataSource.getRepository(Permission).findOne({ where: { id } });
  }
}
