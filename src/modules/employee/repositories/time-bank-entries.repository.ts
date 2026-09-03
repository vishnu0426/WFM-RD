import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { TimeBankEntry } from '../entities/time-bank-entry.entity';

@Injectable()
export class TimeBankEntriesRepository extends TenantScopedRepository<TimeBankEntry> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, TimeBankEntry, tenantContext);
  }

  async create(input: {
    employeeId: string;
    hours: string;
    reason: string;
    entryDate: string;
    createdBy: string | null;
  }): Promise<TimeBankEntry> {
    return this.save({
      id: uuidv4(),
      employeeId: input.employeeId,
      hours: input.hours,
      reason: input.reason,
      entryDate: input.entryDate,
      createdBy: input.createdBy,
    } as TimeBankEntry);
  }

  async findByEmployee(employeeId: string): Promise<TimeBankEntry[]> {
    return this.find({ where: { employeeId } as never, order: { entryDate: 'DESC' } as never });
  }

  /** Live `SUM(hours)` — the balance is never stored, always derived from the ledger. See TimeBankEntry's own doc comment. */
  async balanceForEmployee(employeeId: string): Promise<string> {
    const entries = await this.findByEmployee(employeeId);
    const total = entries.reduce((sum, e) => sum + Number(e.hours), 0);
    return total.toFixed(2);
  }
}
