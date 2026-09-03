import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { WebhookSubscriptionsRepository } from '../repositories/webhook-subscriptions.repository';
import { CreateWebhookSubscriptionDto } from '../dto/create-webhook-subscription.dto';
import { UpdateWebhookSubscriptionDto } from '../dto/update-webhook-subscription.dto';
import { WebhookSubscriptionNotFoundError } from '../errors/webhook-subscription-not-found.error';
import { toWebhookSubscriptionView, WebhookSubscriptionView } from './webhook-subscription.view';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

/**
 * §3.2's webhook subscription CRUD (ADR-0046) - admin surface over
 * `core.webhook_subscriptions`, gated by a new `webhook:read`/`webhook:write`
 * permission pair (same catalog-extension pattern as every earlier phase's
 * new resource - `src/database/seeds/run-seed.ts`'s `RESOURCES`).
 */
@Controller('v1/webhooks')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class WebhookSubscriptionsController {
  constructor(
    private readonly subscriptions: WebhookSubscriptionsRepository,
    private readonly auditLog: AuditLogRepository,
  ) {}

  @Get()
  @RequirePermissions('webhook:read')
  async list(): Promise<WebhookSubscriptionView[]> {
    return (await this.subscriptions.find()).map(toWebhookSubscriptionView);
  }

  @Get(':id')
  @RequirePermissions('webhook:read')
  async get(@Param('id') id: string): Promise<WebhookSubscriptionView> {
    return toWebhookSubscriptionView(await this.getOrFail(id));
  }

  @Post()
  @RequirePermissions('webhook:write')
  async create(
    @Req() req: RequestWithTokenClaims,
    @Body() dto: CreateWebhookSubscriptionDto,
  ): Promise<WebhookSubscriptionView & { secret: string }> {
    // Same shape as `POST /oauth/register`'s client_secret (ADR-0026) -
    // 24 random bytes, base64url-encoded, returned exactly once.
    const secret = randomBytes(24).toString('base64url');
    const created = await this.subscriptions.save({
      url: dto.url,
      description: dto.description ?? null,
      secret,
      subscribedSubjects: dto.subscribedSubjects,
      isActive: true,
    } as never);
    await this.audit(req, 'webhook_subscription.created', created.id, null, {
      url: created.url,
      subscribedSubjects: created.subscribedSubjects,
    });
    return { ...toWebhookSubscriptionView(created), secret };
  }

  @Put(':id')
  @RequirePermissions('webhook:write')
  async update(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookSubscriptionDto,
  ): Promise<WebhookSubscriptionView> {
    const before = await this.getOrFail(id);
    await this.subscriptions.update({ id } as never, dto as never);
    const after = await this.getOrFail(id);
    await this.audit(
      req,
      'webhook_subscription.updated',
      id,
      { url: before.url, isActive: before.isActive, subscribedSubjects: before.subscribedSubjects },
      { url: after.url, isActive: after.isActive, subscribedSubjects: after.subscribedSubjects },
    );
    return toWebhookSubscriptionView(after);
  }

  @Delete(':id')
  @RequirePermissions('webhook:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<void> {
    const before = await this.getOrFail(id);
    await this.subscriptions.delete({ id } as never);
    await this.audit(req, 'webhook_subscription.deleted', id, { url: before.url }, null);
  }

  private async getOrFail(id: string) {
    const subscription = await this.subscriptions.findOne({ where: { id } as never });
    if (!subscription) {
      throw new WebhookSubscriptionNotFoundError(id);
    }
    return subscription;
  }

  private async audit(
    req: RequestWithTokenClaims,
    action: string,
    resourceId: string,
    beforeState: Record<string, unknown> | null,
    afterState: Record<string, unknown> | null,
  ): Promise<void> {
    const claims = req.tokenClaims!;
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action,
      resourceType: 'webhook_subscription',
      resourceId,
      beforeState,
      afterState,
      aiRationale: null,
    });
  }
}
