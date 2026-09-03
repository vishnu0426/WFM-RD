import { Field, InputType } from '@nestjs/graphql';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { EmployeeGroupStatus } from '../entities/employee-group-status.enum';

@InputType()
export class UpdateEmployeeGroupInput {
  @Field(() => String)
  @IsUUID()
  id!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  organizationId?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  parentGroupId?: string | null;

  @Field(() => EmployeeGroupStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EmployeeGroupStatus)
  status?: EmployeeGroupStatus;
}
