import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsEnum,
  IsISO8601,
  IsObject,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OfflineActionType } from '../entities/offline-action-queue.entity';

export class MobileSyncActionDto {
  /** Client-generated - this IS the OfflineActionQueue primary key and the
   * real per-action idempotency mechanism (docs/adr/0152), not a
   * server-assigned id. */
  @IsUUID()
  id!: string;

  @IsUUID()
  employeeId!: string;

  @IsEnum(OfflineActionType)
  actionType!: OfflineActionType;

  @IsObject()
  payload!: Record<string, unknown>;

  /** Set once, client-side, at the moment the action was queued - sacred,
   * never overwritten by sync time (source spec's non-negotiable). */
  @IsISO8601()
  createdAtDevice!: string;
}

/**
 * `POST /v1/mobile/sync`'s request body (source spec §3.2). `actions`
 * bounded to 50 - the module's own stated batch SLO; a locally-queued
 * backlog larger than this chunks across multiple calls client-side
 * (`mobile-app/src/offlineQueue/syncEngine.ts`), never sent as one
 * unbounded request.
 */
export class MobileSyncBatchRequestDto {
  @IsString()
  @MinLength(1)
  deviceId!: string;

  @ValidateNested({ each: true })
  @Type(() => MobileSyncActionDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  actions!: MobileSyncActionDto[];
}
