import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * User Management audit GAP-03: closes the previously-disclosed gap that
 * the reference's "Recording properties" / "System Defined" / "Inbox" /
 * "Conditional custom data" / "Inherit settings from current organization"
 * fields had no backend at all. One row per org unit that has ever had its
 * own settings configured — an org unit with no row simply inherits (see
 * `OrgUnitInteractionSettingsService.resolveEffective`). No telephony or
 * call-recording integration exists anywhere in this platform to *act* on
 * these percentages — this is a real, persisted configuration surface, not
 * a claim that recording actually happens.
 */
@Entity({ schema: 'org', name: 'org_unit_interaction_settings' })
export class OrgUnitInteractionSettings {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'org_unit_id' })
  orgUnitId!: string;

  @Column({ type: 'boolean', name: 'inherit_from_parent', default: true })
  inheritFromParent!: boolean;

  /** "Use the platform default (no recording) rather than the values below" — the reference's "System Defined" flag. */
  @Column({ type: 'boolean', name: 'system_defined', default: true })
  systemDefined!: boolean;

  @Column({ type: 'numeric', precision: 5, scale: 2, name: 'audio_recording_percentage', nullable: true })
  audioRecordingPercentage!: string | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, name: 'video_recording_percentage', nullable: true })
  videoRecordingPercentage!: string | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, name: 'screen_recording_percentage', nullable: true })
  screenRecordingPercentage!: string | null;

  @Column({ type: 'text', name: 'inbox_url', nullable: true })
  inboxUrl!: string | null;

  @Column({ type: 'jsonb', name: 'conditional_custom_data', nullable: true })
  conditionalCustomData!: Record<string, unknown> | null;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'uuid', name: 'updated_by', nullable: true })
  updatedBy!: string | null;
}
