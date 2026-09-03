/**
 * §4's subject grammar: `agno.<domain>.<entity>.<event>.v<version>`. NATS
 * JetStream, not Kafka, per §1. `domain = core` for every Module 01 event -
 * `agno.org.*`/`agno.org.dlq.v1` (Module 02) are a separate stream/DLQ
 * entirely, never mixed with this module's.
 */
export const SUBJECTS = {
  AUDIT_CREATED: 'agno.core.audit.created.v1',
  POLICY_CHANGED: 'agno.core.policy.changed.v1',
  DLQ: 'agno.core.dlq.v1',
} as const;

/** §4: every downstream consumer (e.g. the Identity & Audit Console) keys idempotency on this triple. */
export interface AuditEventPayload {
  auditLogId: string;
  tenantId: string;
  actorId: string | null;
  actorType: 'user' | 'system' | 'ai_agent';
  action: string;
  resourceType: string;
  resourceId: string | null;
  createdAt: string;
}

/** §4: every module holding a cached copy of a policy (e.g. Scheduling's overtime rules) invalidates on this. */
export interface PolicyChangedPayload {
  policyId: string;
  policyGroupId: string;
  tenantId: string;
  policyType: string;
  orgUnitId: string | null;
  version: number;
  effectiveFrom: string;
}
