import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { SkillStatus } from './skill-status.enum';

@Entity({ schema: 'org', name: 'skills' })
@Index('idx_skills_tenant_id_category', ['tenantId', 'category'])
export class Skill {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 100 })
  category!: string;

  @Column({ type: 'boolean', name: 'requires_certification', default: false })
  requiresCertification!: boolean;

  @Column({ type: 'int', name: 'certification_validity_days', nullable: true })
  certificationValidityDays!: number | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 20, default: SkillStatus.ACTIVE })
  status!: SkillStatus;
}
