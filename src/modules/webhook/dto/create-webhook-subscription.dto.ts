import { ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUrl } from 'class-validator';
import { SUBJECTS } from '../../core-eventing/subjects';

/** The only subjects a webhook subscription can ask for right now - see ADR-0046's explicit scope note (Module 02's `org.*` subjects aren't wired to fan-out yet). */
const SUBSCRIBABLE_SUBJECTS = [SUBJECTS.AUDIT_CREATED, SUBJECTS.POLICY_CHANGED] as const;

export class CreateWebhookSubscriptionDto {
  @IsUrl({ require_tld: false })
  url!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(SUBSCRIBABLE_SUBJECTS, { each: true })
  subscribedSubjects!: string[];
}
