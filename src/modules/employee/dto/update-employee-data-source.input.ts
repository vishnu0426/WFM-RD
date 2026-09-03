import { Field, InputType } from '@nestjs/graphql';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** `updateEmployeeDataSource` — `dataSource`/`employeeId` are the row's identity and aren't editable; delete and re-add to change which system a row represents. */
@InputType()
export class UpdateEmployeeDataSourceInput {
  @Field(() => String)
  @IsUUID()
  id!: string;

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
