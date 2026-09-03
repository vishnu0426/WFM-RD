import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUrl } from 'class-validator';
import { SUBJECTS } from '../../core-eventing/subjects';

const SUBSCRIBABLE_SUBJECTS = [SUBJECTS.AUDIT_CREATED, SUBJECTS.POLICY_CHANGED] as const;

export class UpdateWebhookSubscriptionDto {
  @IsOptional()
  @IsUrl({ require_tld: false })
  url?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(SUBSCRIBABLE_SUBJECTS, { each: true })
  subscribedSubjects?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
