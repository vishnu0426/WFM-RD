import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum AiLlmProvider {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  GEMINI = 'gemini',
  OLLAMA = 'ollama',
}

/**
 * A tenant's own bring-your-own-key LLM provider choice - not in the
 * source spec's §2.1 literal entity list (that spec assumed a single
 * platform-wide Anthropic integration, §1). Added per an explicit,
 * deliberate deviation from §1's "Anthropic only" default: each tenant
 * configures their own provider, model, and API key; `ScheduleExplanationService`
 * (and every later interaction-generating service) resolves this per
 * tenant, per call - never a platform-wide static credential. See
 * docs/adr/0117; `GEMINI`/`OLLAMA` added per docs/adr/0129.
 *
 * `encryptedApiKey` is write-only from the outside - no GraphQL query ever
 * returns it (the `oauth_clients` signing-secret precedent, ADR-0046: shown
 * once at configuration time, never again). Nullable (docs/adr/0129): the
 * three cloud providers (`ANTHROPIC`/`OPENAI`/`GEMINI`) all require a real
 * key, enforced in `AiProviderConfigService.configure`, not by a NOT NULL
 * column - `OLLAMA` is typically a tenant's own self-hosted, unauthenticated
 * instance with no key to encrypt at all.
 *
 * `baseUrl` is required for, and only meaningful to, `OLLAMA` - a
 * self-hosted provider has no fixed platform endpoint the way the three
 * cloud providers do. Plaintext, not a secret the way `encryptedApiKey` is.
 *
 * One row per tenant (v1 - a single provider/model/key for every
 * interaction type, not `AIGovernancePolicy`'s per-`action_type`
 * granularity; a tenant wanting different providers per interaction type is
 * a real, plausible future need but not what was asked for here).
 */
@Entity({ name: 'ai_provider_config', schema: 'ai_layer' })
export class AiProviderConfig {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { name: 'provider' })
  provider!: AiLlmProvider;

  @Column('varchar', { name: 'model' })
  model!: string;

  @Column('text', { name: 'encrypted_api_key', nullable: true })
  encryptedApiKey!: string | null;

  @Column('varchar', { name: 'base_url', length: 500, nullable: true })
  baseUrl!: string | null;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'updated_at' })
  updatedAt!: Date;

  @Column('uuid', { name: 'updated_by', nullable: true })
  updatedBy!: string | null;
}
