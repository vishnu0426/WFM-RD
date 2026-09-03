import { randomUUID } from 'node:crypto';
import { Field, ID, InputType, Mutation, ObjectType, Resolver, Args } from '@nestjs/graphql';
import { IsDate, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { ActivityEventDto } from '../../ingestion/dto/activity-event.dto';
import { IngestionService } from '../../ingestion/ingestion.service';

/**
 * `class-validator` decorators are required here, not just `@Field()` -
 * `main.ts`'s global `ValidationPipe({ whitelist: true })` runs on every
 * transport, GraphQL included, and strips/rejects any property it has no
 * validation metadata for. Found by real end-to-end testing (every field
 * came back "should not exist"), not something the type system alone
 * would have caught.
 */
@InputType()
export class ReportActivityChangeInput {
  @Field(() => ID)
  @IsUUID()
  employeeId!: string;

  @Field(() => String)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  currentActivity!: string;

  @Field(() => Date)
  @IsDate()
  activityStartedAt!: Date;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  queueId?: string;
}

@ObjectType('ReportActivityChangeResult')
export class ReportActivityChangeResult {
  @Field(() => String)
  status!: 'accepted' | 'duplicate';

  @Field(() => String)
  sourceEventId!: string;
}

/**
 * §4.1's `reportActivityChange` mutation - "manual fallback path - not
 * the primary ingestion mechanism" (§1). Reuses `IngestionService.ingest`
 * (§4.2's webhook handler, Phase 1) unchanged: same idempotency/NATS-publish
 * semantics either way, only the caller and the `sourceEventId` source
 * differ - a manual report has no ACD-provided event id, so one is
 * generated here, prefixed `manual:` so it's visibly distinguishable from
 * an ACD-sourced id in logs/metrics/NATS payloads.
 */
@Resolver()
export class ActivityChangeResolver {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Mutation(() => ReportActivityChangeResult)
  async reportActivityChange(@Args('input') input: ReportActivityChangeInput): Promise<ReportActivityChangeResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const event: ActivityEventDto = {
      sourceEventId: `manual:${randomUUID()}`,
      employeeId: input.employeeId,
      currentActivity: input.currentActivity,
      activityStartedAt: input.activityStartedAt.toISOString(),
      siteId: input.siteId,
      queueId: input.queueId,
    };
    const outcome = await this.ingestion.ingest(tenantId, event);
    return { status: outcome, sourceEventId: event.sourceEventId };
  }
}
