import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { ErasureRequestStatus } from './erasure-request-status.enum';

/**
 * §2.4 / ADR-0011. This table only models the *mechanism* (request lifecycle
 * + audit trail) - the field-by-field anonymization it triggers on
 * `status = 'completed'` is Phase 8 application logic, and the legal
 * sufficiency of what counts as a valid request is explicitly out of scope
 * for engineering (§2.4, §9). `legal_basis` is intentionally free-text
 * (`varchar`, not an enum): which bases are valid is a legal/compliance
 * decision this schema does not get to make.
 */
@Entity({ schema: 'org', name: 'erasure_requests' })
@Index('idx_erasure_requests_tenant_id_employee_id', ['tenantId', 'employeeId'])
@Index('idx_erasure_requests_tenant_id_status', ['tenantId', 'status'])
export class ErasureRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'employee_id' })
  employeeId!: string;

  @Column({ type: 'uuid', name: 'requested_by' })
  requestedBy!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'requested_at' })
  requestedAt!: Date;

  @Column({ type: 'varchar', length: 255, name: 'legal_basis' })
  legalBasis!: string;

  @Column({ type: 'varchar', length: 20, default: ErasureRequestStatus.PENDING })
  status!: ErasureRequestStatus;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt!: Date | null;
}
