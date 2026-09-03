import { Field, InputType } from '@nestjs/graphql';
import { IsEnum, IsOptional, IsString, IsUUID, Length, MaxLength, MinLength } from 'class-validator';
import { OrgUnitType } from '../entities/org-unit-type.enum';

@InputType()
export class CreateOrgUnitInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  parentOrgUnitId?: string | null;

  @Field(() => OrgUnitType)
  @IsEnum(OrgUnitType)
  type!: OrgUnitType;

  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  timezone!: string;

  @Field()
  @IsString()
  @Length(2, 2)
  countryCode!: string;
}
