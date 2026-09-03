import { Field, InputType } from '@nestjs/graphql';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** `legal_basis` stays free-text end to end (ADR-0011) - which bases are legally valid is out of engineering's hands. */
@InputType()
export class CreateErasureRequestInput {
  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  legalBasis!: string;
}
