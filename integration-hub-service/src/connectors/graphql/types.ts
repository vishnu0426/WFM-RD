import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  ConnectorStatus,
  ConnectorType,
  SyncJobStatus,
} from '../../integrations/entities/integration-connector.entity';
import { IntegrationConnector } from '../../integrations/entities/integration-connector.entity';
import { FieldMapping, FieldMappingAuthority } from '../../integrations/entities/field-mapping.entity';
import { SyncJob } from '../../integrations/entities/sync-job.entity';
import {
  FieldAuthorityPolicy,
  FieldAuthoritySource,
  FieldConflictAction,
} from '../../integrations/entities/field-authority-policy.entity';
import { CreateConnectorResult } from '../integration-connectors.service';

registerEnumType(ConnectorType, { name: 'ConnectorType' });
registerEnumType(ConnectorStatus, { name: 'ConnectorStatus' });
registerEnumType(SyncJobStatus, { name: 'SyncJobStatus' });
registerEnumType(FieldMappingAuthority, { name: 'FieldMappingAuthority' });
registerEnumType(FieldAuthoritySource, { name: 'FieldAuthoritySource' });
registerEnumType(FieldConflictAction, { name: 'FieldConflictAction' });

/** §3.1's named field set exactly - never `config` (the credential-reference-bearing column, ADR-0134), which no query in §3.1 exposes. */
@ObjectType('IntegrationConnector')
export class IntegrationConnectorResult {
  @Field(() => ID)
  id!: string;

  @Field(() => ConnectorType)
  connectorType!: ConnectorType;

  @Field()
  provider!: string;

  @Field(() => ConnectorStatus)
  status!: ConnectorStatus;

  @Field(() => Date, { nullable: true })
  lastSyncAt!: Date | null;

  @Field(() => SyncJobStatus, { nullable: true })
  lastSyncStatus!: SyncJobStatus | null;
}

@ObjectType('CreateConnectorResult')
export class CreateConnectorResultType {
  @Field(() => IntegrationConnectorResult)
  connector!: IntegrationConnectorResult;

  /** Set only for the OAuth path (§1) - null for a non-OAuth connector, which is active immediately. */
  @Field(() => String, { nullable: true })
  authorizationUrl!: string | null;
}

@ObjectType('FieldMapping')
export class FieldMappingResult {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  connectorId!: string;

  @Field()
  sourceField!: string;

  @Field()
  targetField!: string;

  @Field(() => Object, { nullable: true })
  transformationRule!: Record<string, unknown> | null;

  @Field(() => String, { nullable: true })
  authority!: string | null;
}

@ObjectType('SyncJob')
export class SyncJobResult {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  connectorId!: string;

  @Field()
  syncType!: string;

  @Field()
  status!: string;

  @Field(() => Number)
  recordsProcessed!: number;

  @Field(() => Number)
  recordsFailed!: number;

  @Field(() => Number, { nullable: true })
  recordsConflicted!: number | null;

  @Field(() => Object, { nullable: true })
  errorDetails!: Record<string, unknown> | null;

  @Field(() => Date)
  startedAt!: Date;

  @Field(() => Date, { nullable: true })
  completedAt!: Date | null;

  /** §5a: set while this (still `RUNNING`) job is mid-retry in the reactive backoff loop — a live "currently throttled" signal, distinct from a merely slow sync. Only meaningful while `status === RUNNING`; a stale value on a terminal job is a historical artifact, not current state. */
  @Field(() => Date, { nullable: true })
  rateLimitedUntil!: Date | null;
}

/**
 * §7 Phase 8's connector health dashboard - an aggregate, not a direct
 * entity mapping (no `to...Result` converter below; built inline in
 * `ConnectorHealthResolver` from `IntegrationConnector` + its own recent
 * `SyncJob` history + the current streaming-relay status), the same
 * "aggregation query over already-real data, no new schema" shape as
 * every other module's own read-side dashboard.
 */
@ObjectType('ConnectorHealth')
export class ConnectorHealthResult {
  @Field(() => ID)
  connectorId!: string;

  @Field()
  provider!: string;

  @Field(() => ConnectorType)
  connectorType!: ConnectorType;

  @Field(() => ConnectorStatus)
  status!: ConnectorStatus;

  @Field(() => Date, { nullable: true })
  lastSyncAt!: Date | null;

  @Field(() => SyncJobStatus, { nullable: true })
  lastSyncStatus!: SyncJobStatus | null;

  @Field(() => [SyncJobResult])
  recentSyncJobs!: SyncJobResult[];

  /** `acd` connectors only - true if `StreamingRelayService`'s own latest streaming `SyncJob` for this connector is `running`. Always `false` for a batch connector type. */
  @Field(() => Boolean)
  hasActiveStreamingSession!: boolean;
}

@ObjectType('FieldAuthorityPolicy')
export class FieldAuthorityPolicyResult {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  connectorId!: string;

  @Field()
  fieldName!: string;

  @Field(() => FieldAuthoritySource)
  authoritativeSource!: FieldAuthoritySource;

  @Field(() => FieldConflictAction)
  conflictAction!: FieldConflictAction;
}

export function toIntegrationConnectorResult(connector: IntegrationConnector): IntegrationConnectorResult {
  return {
    id: connector.id,
    connectorType: connector.connectorType,
    provider: connector.provider,
    status: connector.status,
    lastSyncAt: connector.lastSyncAt,
    lastSyncStatus: connector.lastSyncStatus,
  };
}

export function toCreateConnectorResultType(result: CreateConnectorResult): CreateConnectorResultType {
  return {
    connector: toIntegrationConnectorResult(result.connector),
    authorizationUrl: result.authorizationUrl,
  };
}

export function toFieldMappingResult(mapping: FieldMapping): FieldMappingResult {
  return {
    id: mapping.id,
    connectorId: mapping.connectorId,
    sourceField: mapping.sourceField,
    targetField: mapping.targetField,
    transformationRule: mapping.transformationRule,
    authority: mapping.authority,
  };
}

export function toSyncJobResult(job: SyncJob): SyncJobResult {
  return {
    id: job.id,
    connectorId: job.connectorId,
    syncType: job.syncType,
    status: job.status,
    recordsProcessed: job.recordsProcessed,
    recordsFailed: job.recordsFailed,
    recordsConflicted: job.recordsConflicted,
    errorDetails: job.errorDetails,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    rateLimitedUntil: job.rateLimitedUntil,
  };
}

export function toFieldAuthorityPolicyResult(policy: FieldAuthorityPolicy): FieldAuthorityPolicyResult {
  return {
    id: policy.id,
    connectorId: policy.connectorId,
    fieldName: policy.fieldName,
    authoritativeSource: policy.authoritativeSource,
    conflictAction: policy.conflictAction,
  };
}
