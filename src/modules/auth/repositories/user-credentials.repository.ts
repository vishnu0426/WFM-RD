import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { UserCredential } from '../entities/user-credential.entity';

@Injectable()
export class UserCredentialsRepository extends TenantScopedRepository<UserCredential> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, UserCredential, tenantContext);
  }

  async findByUserId(userId: string): Promise<UserCredential | null> {
    return this.findOne({ where: { userId } as never });
  }
}
