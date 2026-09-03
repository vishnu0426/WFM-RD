import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Closes the User Management audit's follow-up gap: `Employee.agentId`/
 * `extension`/`dataSource` (migration `1700000027000`) modeled at most one
 * ACD linkage per employee, but a real contact-center deployment assigns a
 * *separate* Agent ID/Extension per system an employee is provisioned on
 * (e.g. Avaya AACC, Avaya Communication Manager, a speech-recognition data
 * source, the WFM system's own data source) - the reference screenshot this
 * gap was found from shows exactly that: one row per system, not one
 * overall. This table replaces those three columns entirely (migration
 * `1700000035000` drops them after backfilling one row per employee that
 * had a non-null `data_source`), one row per (employee, data source).
 */
@Entity({ schema: 'org', name: 'employee_data_sources' })
export class EmployeeDataSource {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'employee_id' })
  employeeId!: string;

  /** e.g. "AACC", "CM", "SR_DS", "WFM_DS" in the reference system, or any ACD connector name integration-hub-service exposes — a plain string, same as the single column it replaces (no fixed enum: this platform's own set of connectors is tenant-configurable, not hardcoded). */
  @Column({ type: 'varchar', length: 100, name: 'data_source' })
  dataSource!: string;

  @Column({ type: 'varchar', length: 100, name: 'agent_id', nullable: true })
  agentId!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  extension!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
