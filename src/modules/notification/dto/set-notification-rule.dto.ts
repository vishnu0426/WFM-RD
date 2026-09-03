import { IsBoolean } from 'class-validator';

/** `PUT /v1/notification-rules/:eventType/:channel`'s body — both path params, not repeated here. */
export class SetNotificationRuleDto {
  @IsBoolean()
  enabled!: boolean;
}
