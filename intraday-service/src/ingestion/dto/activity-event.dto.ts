import { IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * §4.2's `POST .../activity-events` body. Deliberately narrow to what an
 * ACD/CCaaS state-change push actually carries - `scheduledActivity` is
 * *not* a field here: per §2.2 rule 2, that's pre-loaded into
 * `AgentLiveState` from Module 04's published `Schedule` at shift start
 * (Phase 2), never supplied by the webhook itself.
 */
export class ActivityEventDto {
  /** The ACD/CCaaS system's own event id - what `IngestionService` dedupes on (§4.2). */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  sourceEventId!: string;

  @IsUUID()
  employeeId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  currentActivity!: string;

  @IsISO8601()
  activityStartedAt!: string;

  @IsOptional()
  @IsUUID()
  siteId?: string;

  @IsOptional()
  @IsUUID()
  queueId?: string;
}
