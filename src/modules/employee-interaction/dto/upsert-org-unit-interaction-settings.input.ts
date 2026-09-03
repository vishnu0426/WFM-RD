import { Field, InputType } from '@nestjs/graphql';
import { IsBoolean, IsObject, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/** `upsertOrgUnitInteractionSettings` — see `OrgUnitInteractionSettings`'s own doc comment for the gap this closes. */
@InputType()
export class UpsertOrgUnitInteractionSettingsInput {
  @Field(() => String)
  @IsUUID()
  orgUnitId!: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  inheritFromParent?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  systemDefined?: boolean;

  @Field(() => Number, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(100)
  audioRecordingPercentage?: number | null;

  @Field(() => Number, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(100)
  videoRecordingPercentage?: number | null;

  @Field(() => Number, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(100)
  screenRecordingPercentage?: number | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  inboxUrl?: string | null;

  @Field(() => String, { nullable: true, description: 'JSON-encoded object — arbitrary shape, no fixed schema exists for "conditional custom data" anywhere in this platform.' })
  @IsOptional()
  @IsString()
  conditionalCustomDataJson?: string | null;
}
