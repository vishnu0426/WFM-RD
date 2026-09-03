import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { ScorecardSourceSystem, ScorecardSourceSystemStatus } from '../entities/scorecard-source-system.entity';
import { ScorecardSourceMeasure } from '../entities/scorecard-source-measure.entity';
import { ScorecardSourceCode } from '../entities/scorecard-source-code.entity';
import { ScorecardSourceMapping } from '../entities/scorecard-source-mapping.entity';
import { ScorecardDimensionType } from '../entities/scorecard-dimension-type.entity';
import { ScorecardDimensionMember } from '../entities/scorecard-dimension-member.entity';

registerEnumType(ScorecardSourceSystemStatus, { name: 'ScorecardSourceSystemStatus' });

@ObjectType('ScorecardSourceSystem')
export class ScorecardSourceSystemResult {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field() provider!: string;
  @Field(() => ID, { nullable: true }) connectorId!: string | null;
  @Field(() => ScorecardSourceSystemStatus) status!: ScorecardSourceSystemStatus;
  @Field(() => Date) updatedAt!: Date;
}

@ObjectType('ScorecardSourceMeasure')
export class ScorecardSourceMeasureResult {
  @Field(() => ID) id!: string;
  @Field(() => ID) sourceSystemId!: string;
  @Field() code!: string;
  @Field() name!: string;
  @Field(() => String, { nullable: true }) description!: string | null;
  @Field(() => String, { nullable: true }) unit!: string | null;
  @Field(() => Date) updatedAt!: Date;
}

@ObjectType('ScorecardSourceCode')
export class ScorecardSourceCodeResult {
  @Field(() => ID) id!: string;
  @Field(() => ID) sourceSystemId!: string;
  @Field() code!: string;
  @Field(() => String, { nullable: true }) description!: string | null;
  @Field(() => Date) updatedAt!: Date;
}

@ObjectType('ScorecardSourceMapping')
export class ScorecardSourceMappingResult {
  @Field(() => ID) id!: string;
  @Field(() => ID) sourceMeasureId!: string;
  @Field() targetMetric!: string;
  @Field(() => String, { nullable: true }) description!: string | null;
  @Field(() => Date) updatedAt!: Date;
}

@ObjectType('ScorecardDimensionType')
export class ScorecardDimensionTypeResult {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field(() => String, { nullable: true }) description!: string | null;
  @Field(() => Date) updatedAt!: Date;
}

@ObjectType('ScorecardDimensionMember')
export class ScorecardDimensionMemberResult {
  @Field(() => ID) id!: string;
  @Field(() => ID) dimensionTypeId!: string;
  @Field() code!: string;
  @Field() name!: string;
  @Field(() => Date) updatedAt!: Date;
}

export function toSourceSystemResult(r: ScorecardSourceSystem): ScorecardSourceSystemResult {
  return { id: r.id, name: r.name, provider: r.provider, connectorId: r.connectorId, status: r.status, updatedAt: r.updatedAt };
}
export function toSourceMeasureResult(r: ScorecardSourceMeasure): ScorecardSourceMeasureResult {
  return { id: r.id, sourceSystemId: r.sourceSystemId, code: r.code, name: r.name, description: r.description, unit: r.unit, updatedAt: r.updatedAt };
}
export function toSourceCodeResult(r: ScorecardSourceCode): ScorecardSourceCodeResult {
  return { id: r.id, sourceSystemId: r.sourceSystemId, code: r.code, description: r.description, updatedAt: r.updatedAt };
}
export function toSourceMappingResult(r: ScorecardSourceMapping): ScorecardSourceMappingResult {
  return { id: r.id, sourceMeasureId: r.sourceMeasureId, targetMetric: r.targetMetric, description: r.description, updatedAt: r.updatedAt };
}
export function toDimensionTypeResult(r: ScorecardDimensionType): ScorecardDimensionTypeResult {
  return { id: r.id, name: r.name, description: r.description, updatedAt: r.updatedAt };
}
export function toDimensionMemberResult(r: ScorecardDimensionMember): ScorecardDimensionMemberResult {
  return { id: r.id, dimensionTypeId: r.dimensionTypeId, code: r.code, name: r.name, updatedAt: r.updatedAt };
}
