import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SigningKey } from '../entities/signing-key.entity';
import { SigningKeyStatus } from '../entities/signing-key-status.enum';

/**
 * ADR-0024: `signing_keys` is global platform reference data (no
 * `tenant_id`, no RLS), so this repository is a plain wrapper over
 * `DataSource` - not a `TenantScopedRepository` - matching how `Permission`
 * (the only other global-reference-data entity in this module) is read
 * directly rather than through a tenant-guarded base class.
 */
@Injectable()
export class SigningKeysRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findActive(): Promise<SigningKey | null> {
    return this.dataSource.getRepository(SigningKey).findOne({ where: { status: SigningKeyStatus.ACTIVE } });
  }

  async findByKid(kid: string): Promise<SigningKey | null> {
    return this.dataSource.getRepository(SigningKey).findOne({ where: { kid } });
  }

  /** JWKS-eligible: the active key plus any retired key still inside its verification grace window. */
  async findVerifiable(retiredSinceAfter: Date): Promise<SigningKey[]> {
    const repo = this.dataSource.getRepository(SigningKey);
    const [active, retired] = await Promise.all([
      repo.findOne({ where: { status: SigningKeyStatus.ACTIVE } }),
      repo
        .createQueryBuilder('sk')
        .where('sk.status = :status', { status: SigningKeyStatus.RETIRED })
        .andWhere('sk.retired_at > :cutoff', { cutoff: retiredSinceAfter })
        .getMany(),
    ]);
    return [active, ...retired].filter((key): key is SigningKey => key !== null);
  }

  async save(key: SigningKey): Promise<SigningKey> {
    return this.dataSource.getRepository(SigningKey).save(key);
  }

  /** Atomically retires the currently active key and inserts its replacement (ADR-0024's rotation). */
  async rotate(newKey: SigningKey): Promise<SigningKey> {
    return this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(SigningKey)
        .update({ status: SigningKeyStatus.ACTIVE }, { status: SigningKeyStatus.RETIRED, retiredAt: new Date() });
      return manager.getRepository(SigningKey).save(newKey);
    });
  }
}
