import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * "Time Banks" in the reference console's own menu — a ledger of banked/
 * comp-time hours per employee. `hours` is signed: positive rows are an
 * accrual (e.g. worked overtime converted to banked time instead of paid
 * out), negative rows are a draw-down (time taken against the balance).
 * The balance itself is never stored — always the live `SUM(hours)` over
 * this table (`TimeBankEntriesRepository.balanceForEmployee`), so it can
 * never drift from its own ledger.
 */
@Entity({ schema: 'org', name: 'time_bank_entries' })
@Index('idx_time_bank_entries_tenant_id_employee_id', ['tenantId', 'employeeId'])
export class TimeBankEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'employee_id' })
  employeeId!: string;

  @Column({ type: 'numeric', precision: 7, scale: 2 })
  hours!: string;

  @Column({ type: 'varchar', length: 255 })
  reason!: string;

  @Column({ type: 'date', name: 'entry_date' })
  entryDate!: string;

  @Column({ type: 'uuid', name: 'created_by', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
