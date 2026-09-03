/**
 * §4's subject grammar: `agno.org.<entity>.<event>.v<version>`. Kafka is
 * explicitly overridden to NATS JetStream per §1 - these are JetStream
 * subjects, not Kafka topics.
 */
export const SUBJECTS = {
  EMPLOYEE_CHANGED: 'agno.org.employee.changed.v1',
  SKILL_EXPIRING: 'agno.org.skill.expiring.v1',
  DLQ: 'agno.org.dlq.v1',
} as const;

export type EmployeeChangedSubType = 'created' | 'updated' | 'transferred' | 'terminated' | 'erased';

/**
 * §4: consumers key idempotency on `(employee_id, event_type, updated_at)` -
 * all three are carried in the payload so a consumer (Scheduling, per §4's
 * consumer table, invalidates its cached `GetSchedulableEmployees` result
 * for the affected org unit) can dedupe without a second lookup.
 */
export interface EmployeeChangedPayload {
  employeeId: string;
  tenantId: string;
  eventType: EmployeeChangedSubType;
  orgUnitId: string;
  updatedAt: string;
}

export interface SkillExpiringPayload {
  employeeId: string;
  tenantId: string;
  skillId: string;
  expiryDate: string;
}
