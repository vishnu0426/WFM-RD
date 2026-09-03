import { BadRequestException, Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { NotificationRulesRepository } from '../repositories/notification-rules.repository';
import { NotificationChannel } from '../entities/notification-channel.enum';
import { SetNotificationRuleDto } from '../dto/set-notification-rule.dto';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

/**
 * System Configuration's "Notification Rules" — tenant-wide default for
 * "when event X fires, is channel Y on by default." Same
 * `TenantSettingsController` shape (permission-gated, per-mutation audit) —
 * see `NotificationService.enqueue`'s own doc comment for exactly how this
 * is consulted (an explicit user `NotificationPreference` always wins; this
 * is only the fallback for channels a user has no preference row for).
 *
 * `eventType` has no catalog/enum anywhere in this platform (only
 * `skill_expiring` has a real producer today) — `GET /v1/notification-rules`
 * lists whatever rules exist without pretending there's a fixed list to
 * validate `eventType` against, same free-string posture as
 * `NotificationPreference.eventType`/`NotificationDelivery.eventType`.
 */
@Controller('v1/notification-rules')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class NotificationRulesController {
  constructor(
    private readonly rules: NotificationRulesRepository,
    private readonly auditLog: AuditLogRepository,
  ) {}

  @Get()
  @RequirePermissions('tenant_settings:read')
  async list() {
    return this.rules.find({});
  }

  @Put(':eventType/:channel')
  @RequirePermissions('tenant_settings:write')
  async set(
    @Req() req: RequestWithTokenClaims,
    @Param('eventType') eventType: string,
    @Param('channel') channel: string,
    @Body() dto: SetNotificationRuleDto,
  ) {
    if (!Object.values(NotificationChannel).includes(channel as NotificationChannel)) {
      throw new BadRequestException(`Unknown channel "${channel}".`);
    }
    const claims = req.tokenClaims!;
    const before = await this.rules.findOne({ where: { eventType, channel } as never }).catch(() => null);
    const after = await this.rules.setEnabled(eventType, channel, dto.enabled);
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'notification_rule.changed',
      resourceType: 'notification_rule',
      resourceId: after.id,
      beforeState: before ? { enabled: before.enabled } : null,
      afterState: { eventType, channel, enabled: after.enabled },
      aiRationale: null,
    });
    return after;
  }
}
