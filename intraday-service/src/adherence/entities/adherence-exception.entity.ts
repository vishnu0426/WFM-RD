import { Column, Entity, PrimaryColumn } from 'typeorm';

export type AdherenceExceptionStatus = 'open' | 'acknowledged' | 'resolved';

/**
 * The exceptions-only counterpart `AdherenceEvent` doesn't provide -
 * `adherence_event` logs every activity change including adherent ones
 * (append-only, partitioned, no workflow state); this table holds one row
 * per *completed non-adherent segment* only, with the acknowledge/resolve
 * workflow a call-center scorecard actually needs. Written by
 * `AdherenceCalculatorConsumerService` whenever it computes a nonzero
 * `deviationSeconds` for the segment that just ended - see that file's own
 * doc comment for why `deviationSeconds > 0` always means a real,
 * completed non-adherent segment (never a guess).
 *
 * Same `status` shape as `Alert` (`open`/`acknowledged`/`resolved`,
 * `acknowledgedBy`/`acknowledgedAt`/`resolvedAt`) - deliberately reused
 * rather than inventing a different workflow vocabulary for what is, from
 * a supervisor's perspective, the same kind of "something needs my
 * attention, then I dealt with it" record.
 */
@Entity({ name: 'adherence_exception', schema: 'intraday' })
export class AdherenceException {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'employee_id' })
  employeeId!: string;

  /** What the employee was actually doing during the non-adherent segment (`AdherenceEvent.toActivity` of the segment that just ended). */
  @Column('varchar')
  activity!: string;

  /** What they were scheduled to be doing - `null`/anything other than `"on_shift"` is what made the segment non-adherent in the first place (ADR-0067). */
  @Column('varchar', { name: 'scheduled_activity', nullable: true })
  scheduledActivity!: string | null;

  @Column('timestamptz', { name: 'started_at' })
  startedAt!: Date;

  @Column('timestamptz', { name: 'ended_at' })
  endedAt!: Date;

  @Column('integer', { name: 'deviation_seconds' })
  deviationSeconds!: number;

  @Column('varchar')
  status!: AdherenceExceptionStatus;

  @Column('uuid', { name: 'acknowledged_by', nullable: true })
  acknowledgedBy!: string | null;

  @Column('timestamptz', { name: 'acknowledged_at', nullable: true })
  acknowledgedAt!: Date | null;

  @Column('varchar', { name: 'resolution_notes', nullable: true })
  resolutionNotes!: string | null;

  @Column('timestamptz', { name: 'resolved_at', nullable: true })
  resolvedAt!: Date | null;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;
}
