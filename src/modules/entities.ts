import { Tenant } from './tenant/entities/tenant.entity';
import { User } from './identity/entities/user.entity';
import { Role } from './identity/entities/role.entity';
import { Permission } from './identity/entities/permission.entity';
import { RolePermission } from './identity/entities/role-permission.entity';
import { UserRole } from './identity/entities/user-role.entity';
import { UserInvite } from './identity/entities/user-invite.entity';
import { Policy } from './policy/entities/policy.entity';
import { AuditLog } from './audit/entities/audit-log.entity';
import { NotificationPreference } from './notification/entities/notification-preference.entity';
import { NotificationDelivery } from './notification/entities/notification-delivery.entity';
import { NotificationRule } from './notification/entities/notification-rule.entity';
import { OrgUnit } from './org-unit/entities/org-unit.entity';
import { OrgUnitHistory } from './org-unit/entities/org-unit-history.entity';
import { Employee } from './employee/entities/employee.entity';
import { EmployeeDataSource } from './employee/entities/employee-data-source.entity';
import { EmployeeHistory } from './employee/entities/employee-history.entity';
import { ErasureRequest } from './employee/entities/erasure-request.entity';
import { Skill } from './skill/entities/skill.entity';
import { EmployeeSkill } from './skill/entities/employee-skill.entity';
import { EmployeeSkillHistory } from './skill/entities/employee-skill-history.entity';
import { DecayJobRun } from './skill/entities/decay-job-run.entity';
import { WorkingTimeCalendar } from './calendar/entities/working-time-calendar.entity';
import { WorkingTimeCalendarHistory } from './calendar/entities/working-time-calendar-history.entity';
import { OutboxEvent } from './eventing/entities/outbox-event.entity';
import { BulkImportJob } from './bulk-import/entities/bulk-import-job.entity';
import { FeatureFlag } from './bulk-import/entities/feature-flag.entity';
import { OAuthClient } from './auth/entities/oauth-client.entity';
import { UserCredential } from './auth/entities/user-credential.entity';
import { SigningKey } from './auth/entities/signing-key.entity';
import { AuthorizationCode } from './auth/entities/authorization-code.entity';
import { RefreshToken } from './auth/entities/refresh-token.entity';
import { TenantIdentityProvider } from './sso/entities/tenant-identity-provider.entity';
import { WebAuthnCredential } from './webauthn/entities/webauthn-credential.entity';
// Aliased: Module 02's `org.outbox_events` and Module 01's own
// `core.outbox_events` (Phase 5, ADR-0039) are two distinct tables that
// happen to share an unqualified class name - both are real, both needed.
import { OutboxEvent as CoreOutboxEvent } from './core-eventing/entities/outbox-event.entity';
import { PendingAuditEvent } from './audit/entities/pending-audit-event.entity';
import { WebhookSubscription } from './webhook/entities/webhook-subscription.entity';
import { WebhookDelivery } from './webhook/entities/webhook-delivery.entity';
import { TenantSettings } from './tenant-settings/entities/tenant-settings.entity';
import { TimeBankEntry } from './employee/entities/time-bank-entry.entity';
// Frontend wiring gap-fix: these six entities each already had a working
// `TypeOrmModule.forFeature([...])` registration in their own module (so
// plain `@InjectRepository` call sites never surfaced this), but were never
// added to this barrel - the one array the app's actual `DataSource` is
// constructed from (`src/database/typeorm.config.ts`/`data-source.ts`). Any
// code path going through the raw `DataSource` instead - every
// `TenantScopedRepository` subclass, the entire RLS-safe repository
// convention this codebase otherwise uses everywhere - threw
// `EntityMetadataNotFoundError` for all six, e.g. `Employee.groups`
// (`EmployeeGroupsService.findGroupIdsForEmployee` via
// `EmployeeGroupMembersRepository`).
import { EmployeeGroup } from './employee-group/entities/employee-group.entity';
import { EmployeeGroupMember } from './employee-group/entities/employee-group-member.entity';
import { WorkRule } from './work-rule/entities/work-rule.entity';
import { WorkRuleAssignment } from './work-rule/entities/work-rule-assignment.entity';
import { EmployeeSchedulePreference } from './schedule-preference/entities/employee-schedule-preference.entity';
import { EmployeeInteraction } from './employee-interaction/entities/employee-interaction.entity';
import { OrgUnitInteractionSettings } from './employee-interaction/entities/org-unit-interaction-settings.entity';

/**
 * Single source of truth for "every entity in this module," consumed by
 * both the NestJS TypeOrmModule registration and the CLI DataSource used
 * for migrations/migration-lint. Add new entities here, not in two places.
 */
export const entities = [
  Tenant,
  User,
  Role,
  Permission,
  RolePermission,
  UserRole,
  UserInvite,
  Policy,
  AuditLog,
  NotificationPreference,
  NotificationDelivery,
  NotificationRule,
  OrgUnit,
  OrgUnitHistory,
  Employee,
  EmployeeDataSource,
  EmployeeHistory,
  ErasureRequest,
  Skill,
  EmployeeSkill,
  EmployeeSkillHistory,
  DecayJobRun,
  WorkingTimeCalendar,
  WorkingTimeCalendarHistory,
  OutboxEvent,
  BulkImportJob,
  FeatureFlag,
  OAuthClient,
  UserCredential,
  SigningKey,
  AuthorizationCode,
  RefreshToken,
  TenantIdentityProvider,
  WebAuthnCredential,
  CoreOutboxEvent,
  PendingAuditEvent,
  WebhookSubscription,
  WebhookDelivery,
  TenantSettings,
  TimeBankEntry,
  EmployeeGroup,
  EmployeeGroupMember,
  WorkRule,
  WorkRuleAssignment,
  EmployeeSchedulePreference,
  EmployeeInteraction,
  OrgUnitInteractionSettings,
];

export {
  Tenant,
  User,
  Role,
  Permission,
  RolePermission,
  UserRole,
  UserInvite,
  Policy,
  AuditLog,
  NotificationPreference,
  NotificationDelivery,
  NotificationRule,
  OrgUnit,
  OrgUnitHistory,
  Employee,
  EmployeeDataSource,
  EmployeeHistory,
  ErasureRequest,
  Skill,
  EmployeeSkill,
  EmployeeSkillHistory,
  DecayJobRun,
  WorkingTimeCalendar,
  WorkingTimeCalendarHistory,
  OutboxEvent,
  BulkImportJob,
  FeatureFlag,
  OAuthClient,
  UserCredential,
  SigningKey,
  AuthorizationCode,
  RefreshToken,
  TenantIdentityProvider,
  WebAuthnCredential,
  CoreOutboxEvent,
  PendingAuditEvent,
  WebhookSubscription,
  WebhookDelivery,
  TenantSettings,
  TimeBankEntry,
  EmployeeGroup,
  EmployeeGroupMember,
  WorkRule,
  WorkRuleAssignment,
  EmployeeSchedulePreference,
  EmployeeInteraction,
  OrgUnitInteractionSettings,
};
