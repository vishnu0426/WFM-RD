import { Field, InputType } from '@nestjs/graphql';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/** `addEmployeeDataSource` — see `EmployeeDataSource`'s own doc comment for why this replaced the old single-column model. */
@InputType()
export class CreateEmployeeDataSourceInput {
  @Field(() => String)
  @IsUUID()
  employeeId!: string;

  @Field(() => String)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  dataSource!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  agentId?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  extension?: string | null;
}
