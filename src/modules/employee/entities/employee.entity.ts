import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { EmploymentType } from './employment-type.enum';
import { EmployeeStatus } from './employee-status.enum';

/**
 * ADR-0010: partitioned `PARTITION BY HASH (tenant_id)` (8-way, fixed at
 * creation - see the Phase 1 migration) for the 10M+-row capacity target
 * (§0.5). Postgres requires the partition key in every unique
 * index/PK on a partitioned table, so the PK is composite
 * `(tenant_id, id)` rather than a bare `id` - the same consequence
 * `AuditLog`'s RANGE partitioning had on its own PK (ADR-0005), just for a
 * different partitioning strategy. `id` is still globally unique in
 * practice (UUIDv4 generation), just not DB-enforced across partitions.
 */
@Entity({ schema: 'org', name: 'employees' })
@Index('idx_employees_tenant_id_org_unit_id', ['tenantId', 'orgUnitId'])
@Index('idx_employees_tenant_id_status', ['tenantId', 'status'])
@Index('idx_employees_tenant_id_manager_employee_id', ['tenantId', 'managerEmployeeId'])
export class Employee {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  /** Nullable by design (§2.2 rule 2) - onboarding-in-progress/headcount-only employees don't need login access. */
  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId!: string | null;

  @Column({ type: 'uuid', name: 'org_unit_id' })
  orgUnitId!: string;

  @Column({ type: 'varchar', length: 50, name: 'employee_number' })
  employeeNumber!: string;

  @Column({ type: 'varchar', length: 20, name: 'employment_type' })
  employmentType!: EmploymentType;

  @Column({ type: 'numeric', precision: 5, scale: 2, name: 'contract_hours_per_week' })
  contractHoursPerWeek!: string;

  @Column({ type: 'date', name: 'hire_date' })
  hireDate!: string;

  @Column({ type: 'date', name: 'termination_date', nullable: true })
  terminationDate!: string | null;

  @Column({ type: 'varchar', length: 100, name: 'cost_center', nullable: true })
  costCenter!: string | null;

  @Column({ type: 'uuid', name: 'manager_employee_id', nullable: true })
  managerEmployeeId!: string | null;

  @Column({ type: 'varchar', length: 30, default: EmployeeStatus.PENDING_ONBOARDING })
  status!: EmployeeStatus;

  // --- Personal ---
  @Column({ type: 'varchar', length: 10, name: 'middle_initial', nullable: true })
  middleInitial!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  suffix!: string | null;

  @Column({ type: 'date', name: 'birth_date', nullable: true })
  birthDate!: string | null;

  // --- Contact ---
  @Column({ type: 'varchar', length: 320, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 100, name: 'desktop_messaging_username', nullable: true })
  desktopMessagingUsername!: string | null;

  @Column({ type: 'varchar', length: 30, name: 'home_phone', nullable: true })
  homePhone!: string | null;

  @Column({ type: 'varchar', length: 30, name: 'work_phone', nullable: true })
  workPhone!: string | null;

  @Column({ type: 'varchar', length: 30, name: 'cell_phone', nullable: true })
  cellPhone!: string | null;

  /** `{ street1, street2, city, region, postalCode, country }` — display-only, no query need, jsonb rather than discrete columns. */
  @Column({ type: 'jsonb', name: 'home_address', nullable: true })
  homeAddress!: Record<string, string | null> | null;

  // --- Organizational relationships ---
  /** Marks this employee as eligible to be picked as someone else's Supervisor (`managerEmployeeId`). */
  @Column({ type: 'boolean', name: 'is_supervisor', default: false })
  isSupervisor!: boolean;

  /** Marks this employee as eligible to be picked as someone else's Team Lead. */
  @Column({ type: 'boolean', name: 'is_team_lead', default: false })
  isTeamLead!: boolean;

  @Column({ type: 'uuid', name: 'team_lead_employee_id', nullable: true })
  teamLeadEmployeeId!: string | null;

  @Column({ type: 'varchar', length: 150, name: 'job_title', nullable: true })
  jobTitle!: string | null;

  // --- Compensation ---
  /**
   * Never returned raw from the general read path (`EmployeeGraphQLType`
   * exposes `taxIdLastFour` instead, via `maskTaxId()`) — same disclosed
   * plaintext-column trade-off already accepted for `TenantSettings.smtpPassword`
   * (no column-level encryption in this app outside integration-hub-service's
   * Vault client). Full value only via `GET /v1/employees/:id/tax-id`,
   * audited every call.
   */
  @Column({ type: 'text', name: 'tax_id', nullable: true })
  taxId!: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, name: 'wage_amount', nullable: true })
  wageAmount!: string | null;

  @Column({ type: 'integer', nullable: true })
  rank!: number | null;

  // --- Avatar / ACD ---
  /** Set by `POST /v1/employees/:id/avatar` — `/uploads/avatars/${id}.${ext}`, never client-supplied. */
  @Column({ type: 'text', name: 'avatar_url', nullable: true })
  avatarUrl!: string | null;

  // ACD/telephony identifiers (agentId/extension/dataSource) used to live
  // here as single columns (`1700000027000-EmployeeAvatarAndAcdFields`) -
  // moved to `EmployeeDataSource` (migration `1700000035000`) once it
  // turned out real ACD deployments assign a *separate* Agent ID/Extension
  // per system (AACC, CM, SR_DS, WFM_DS, ...), not one overall - see that
  // entity's own doc comment.

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
