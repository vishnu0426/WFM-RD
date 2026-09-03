import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { AiLlmProvider } from './ai-provider-config.entity';

/**
 * ADR-0132 (SCD Type 2, own copy of Module 02's history-table pattern,
 * ADR-0009 - with one deliberate departure, see the migration's own doc
 * comment): one row per version of an `AiProviderConfig`, written by the
 * `ai_layer.fn_ai_provider_config_history_track` trigger on every INSERT
 * and EVERY UPDATE (not just tracked-column changes - a random-IV
 * re-encryption makes "did the key actually change" unobservable by
 * comparing columns). **`encrypted_api_key` is never copied into this
 * table at all** - only `provider`/`model`/`baseUrl`/`updatedBy` are
 * retained, so this history answers "which provider/model was configured,
 * by whom, when" without ever holding a second copy of a secret.
 */
@Entity({ schema: 'ai_layer', name: 'ai_provider_config_history' })
@Index('idx_ai_provider_config_history_tenant_config', ['tenantId', 'providerConfigId', 'validFrom'])
export class AiProviderConfigHistory {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'provider_config_id' })
  providerConfigId!: string;

  @Column({ type: 'timestamptz', name: 'valid_from' })
  validFrom!: Date;

  /** NULL = this is the currently active version. */
  @Column({ type: 'timestamptz', name: 'valid_to', nullable: true })
  validTo!: Date | null;

  @Column({ type: 'varchar', length: 20 })
  provider!: AiLlmProvider;

  @Column({ type: 'varchar', length: 120 })
  model!: string;

  @Column({ type: 'varchar', length: 500, name: 'base_url', nullable: true })
  baseUrl!: string | null;

  @Column({ type: 'uuid', name: 'updated_by', nullable: true })
  updatedBy!: string | null;
}
