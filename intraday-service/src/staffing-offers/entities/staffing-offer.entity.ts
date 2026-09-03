import { Column, Entity, PrimaryColumn } from 'typeorm';

export type StaffingOfferType = 'vto' | 'overtime';
export type StaffingOfferStatus = 'offered';

/**
 * Detection + push-notification-trigger only, this phase - see
 * `StaffingOfferService`'s own doc comment for exactly what's built and
 * what's deliberately deferred (accept/decline, a terminal status beyond
 * `'offered'`). One row per (queue, employee, offer_type) offer.
 */
@Entity({ name: 'staffing_offer', schema: 'intraday' })
export class StaffingOffer {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'queue_id' })
  queueId!: string;

  @Column('varchar', { name: 'offer_type' })
  offerType!: StaffingOfferType;

  @Column('uuid', { name: 'employee_id' })
  employeeId!: string;

  @Column('varchar')
  reason!: string;

  @Column('varchar')
  status!: StaffingOfferStatus;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;
}
