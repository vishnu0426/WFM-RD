import { Column, Entity, PrimaryColumn } from 'typeorm';

export type IngestionCredentialStatus = 'active' | 'revoked';

/**
 * Replaces the `INTRADAY_WEBHOOK_SECRETS` env-var stopgap
 * (`HmacSignatureGuard`'s own doc comment always named this "no later
 * than Phase 3"). The actual HMAC secret never lives in this table -
 * `secretReference` is a Vault KV v2 path, same discipline
 * `integration-hub-service`'s `WebhookSubscription.secretReference`
 * already established for the identical problem (an inbound/outbound
 * webhook signing secret) - see `IngestionCredentialsService`'s own doc
 * comment.
 *
 * A tenant can hold multiple `active` rows at once (not just one) - that's
 * what makes secret rotation possible without a downtime window: issue a
 * new credential, reconfigure the on-prem collector to use it, then revoke
 * the old one. `HmacSignatureGuard` tries every active credential for the
 * request's tenant until one's secret matches.
 */
@Entity({ name: 'ingestion_credential', schema: 'intraday' })
export class IngestionCredential {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { name: 'secret_reference' })
  secretReference!: string;

  /** Tenant-supplied, human-readable ("Site A on-prem collector") - purely for the admin's own bookkeeping when they hold more than one. */
  @Column('varchar', { nullable: true })
  label!: string | null;

  @Column('varchar')
  status!: IngestionCredentialStatus;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;
}
