import { Injectable } from '@nestjs/common';
import { SkillsRepository } from '../repositories/skills.repository';
import { SkillNotFoundError } from '../errors/skill-not-found.error';
import { Skill } from '../entities/skill.entity';
import { CreateSkillInput } from '../dto/create-skill.input';
import { UpdateSkillInput } from '../dto/update-skill.input';
import { SkillStatus } from '../entities/skill-status.enum';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

/**
 * GAP-06 fix (enterprise readiness audit, 2026-08-18): `create` now records
 * an `audit_log` entry - same `AuditLogRepository.record(...)` pattern
 * `ErasureRequestsService` uses, at the service layer so any future
 * additional caller of `create` inherits it automatically.
 */
@Injectable()
export class SkillsService {
  constructor(
    private readonly skillsRepository: SkillsRepository,
    private readonly tenantContext: TenantContextService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  /** Frontend Skills-tab gap-fix: no query existed to list the skill catalog at all — only single-item `skill(id)` lookup. */
  async findAll(): Promise<Skill[]> {
    return this.skillsRepository.find({ order: { name: 'ASC' } as never });
  }

  async findById(id: string): Promise<Skill> {
    const skill = await this.skillsRepository.findOne({ where: { id } as never });
    if (!skill) {
      throw new SkillNotFoundError(id);
    }
    return skill;
  }

  async create(input: CreateSkillInput): Promise<Skill> {
    const skill = await this.skillsRepository.save({
      name: input.name,
      category: input.category,
      requiresCertification: input.requiresCertification,
      certificationValidityDays: input.requiresCertification ? (input.certificationValidityDays ?? null) : null,
      description: input.description ?? null,
      status: input.status ?? SkillStatus.ACTIVE,
    } as Skill);
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'skill.created',
      resourceType: 'skill',
      resourceId: skill.id,
      beforeState: null,
      afterState: skill as unknown as Record<string, unknown>,
      aiRationale: null,
    });
    return skill;
  }

  async update(input: UpdateSkillInput): Promise<Skill> {
    const before = await this.findById(input.id);
    const partial: Partial<Skill> = {};
    if (input.name !== undefined) partial.name = input.name;
    if (input.category !== undefined) partial.category = input.category;
    if (input.requiresCertification !== undefined) partial.requiresCertification = input.requiresCertification;
    if (input.certificationValidityDays !== undefined) partial.certificationValidityDays = input.certificationValidityDays;
    if (input.description !== undefined) partial.description = input.description;
    if (input.status !== undefined) partial.status = input.status;
    await this.skillsRepository.update({ id: input.id } as never, partial as never);
    const after = await this.findById(input.id);
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'skill.updated',
      resourceType: 'skill',
      resourceId: after.id,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: after as unknown as Record<string, unknown>,
      aiRationale: null,
    });
    return after;
  }
}
