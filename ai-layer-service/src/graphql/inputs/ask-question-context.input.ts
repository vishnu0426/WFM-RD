import { Field, ID, InputType } from '@nestjs/graphql';
import { IsOptional, IsString } from 'class-validator';

/**
 * §6.1's `askQuestion` context - exactly one of the four fields groups
 * below must identify a real resource (`AskQuestionService.resolveSource`
 * enforces this at the domain layer, not here; class-validator's
 * decorators below only check each field's own shape, not the cross-field
 * "exactly one" rule, matching this codebase's existing split between
 * per-field validation via decorators and cross-field business rules via
 * explicit domain-service checks + typed `DomainError`s).
 *
 * `orgUnitId` is deliberately NOT `@IsUUID()` - `RootCauseAnalysisResolver`
 * already treats it as an opaque tenant-defined identifier (its own test
 * fixtures use non-UUID values like "org-1"), not a UUID primary key.
 */
@InputType()
export class AskQuestionContextInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  scheduleJobId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  forecastRunId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  reallocationActionId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  orgUnitId?: string;

  @Field(() => Date, { nullable: true })
  @IsOptional()
  periodStart?: Date;

  @Field(() => Date, { nullable: true })
  @IsOptional()
  periodEnd?: Date;
}
