import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { entities, Tenant } from '../../src/modules/entities';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { OrgUnit } from '../../src/modules/org-unit/entities/org-unit.entity';
import { OrgUnitType } from '../../src/modules/org-unit/entities/org-unit-type.enum';
import { OrgUnitStatus } from '../../src/modules/org-unit/entities/org-unit-status.enum';
import { Employee } from '../../src/modules/employee/entities/employee.entity';
import { EmploymentType } from '../../src/modules/employee/entities/employment-type.enum';
import { EmployeeStatus } from '../../src/modules/employee/entities/employee-status.enum';
import { Skill } from '../../src/modules/skill/entities/skill.entity';
import { EmployeeSkill } from '../../src/modules/skill/entities/employee-skill.entity';
import { ProficiencyLevel } from '../../src/modules/skill/entities/proficiency-level.enum';
import { SkillDecayJobService } from '../../src/modules/skill/services/skill-decay-job.service';
import { DecayJobRunStatus } from '../../src/modules/skill/entities/decay-job-run-status.enum';

dotenv.config();

/**
 * §0.5's named chaos scenario: "simulate the nightly decay job failing
 * halfway through - verify it's resumable/idempotent per employee." Drives
 * `SkillDecayJobService` directly (not over HTTP) - this is an internal
 * batch process, not a caller-facing API. See ADR-0017.
 */
describe('Skill decay job (resumability + idempotency)', () => {
  let app: INestApplication;
  let migratorDataSource: DataSource;
  let skillDecayJobService: SkillDecayJobService;
  let tenantId: string;
  let employeeIds: string[];
  let skillId: string;
  const runDate = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    skillDecayJobService = app.get(SkillDecayJobService);

    migratorDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await migratorDataSource.initialize();

    const tenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `Decay Job Test Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;

    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);

    const orgUnit = await migratorDataSource.getRepository(OrgUnit).save(
      migratorDataSource.getRepository(OrgUnit).create({
        tenantId,
        parentOrgUnitId: null,
        type: OrgUnitType.SITE,
        name: 'Decay Job Test Site',
        timezone: 'UTC',
        countryCode: 'US',
        status: OrgUnitStatus.ACTIVE,
      }),
    );

    const skill = await migratorDataSource.getRepository(Skill).save(
      migratorDataSource.getRepository(Skill).create({
        tenantId,
        name: `Decay Test Skill ${uuidv4()}`,
        category: 'test',
        requiresCertification: false,
        certificationValidityDays: null,
      }),
    );
    skillId = skill.id;

    // 5 employees, each with an EmployeeSkill whose anchor (lastScheduledOnSkillAt)
    // is 180 days ago - matching DEFAULT_HALF_LIFE_DAYS, so a correctly
    // implemented decay run should land decay_score close to 0.5.
    const employeeRepo = migratorDataSource.getRepository(Employee);
    const employeeSkillRepo = migratorDataSource.getRepository(EmployeeSkill);
    const created: Employee[] = [];
    for (let i = 0; i < 5; i += 1) {
      const employee = await employeeRepo.save(
        employeeRepo.create({
          id: uuidv4(),
          tenantId,
          userId: null,
          orgUnitId: orgUnit.id,
          employeeNumber: `DECAY-${i}-${uuidv4()}`,
          employmentType: EmploymentType.FULL_TIME,
          contractHoursPerWeek: '40.00',
          hireDate: '2023-01-01',
          terminationDate: null,
          costCenter: null,
          managerEmployeeId: null,
          status: EmployeeStatus.ACTIVE,
        }),
      );
      created.push(employee);
      await employeeSkillRepo.save(
        employeeSkillRepo.create({
          tenantId,
          employeeId: employee.id,
          skillId,
          proficiencyLevel: ProficiencyLevel.PROFICIENT,
          certifiedDate: null,
          lastScheduledOnSkillAt: new Date(Date.now() - 180 * 86400 * 1000),
        }),
      );
    }
    employeeIds = created.map((e) => e.id).sort();
  });

  afterAll(async () => {
    await app.close();
    await migratorDataSource.destroy();
  });

  const fetchRun = async () => {
    const rows = await migratorDataSource.query(
      'SELECT * FROM org.decay_job_runs WHERE tenant_id = $1 AND run_date = $2',
      [tenantId, runDate],
    );
    return rows[0] as
      | {
          status: string;
          employees_processed: number;
          failures_count: number;
          last_processed_employee_id: string | null;
        }
      | undefined;
  };

  const fetchDecayScores = async (): Promise<Record<string, number>> => {
    const rows = await migratorDataSource.query(
      'SELECT employee_id, decay_score FROM org.employee_skills WHERE tenant_id = $1 AND skill_id = $2',
      [tenantId, skillId],
    );
    const byEmployee: Record<string, number> = {};
    for (const row of rows as { employee_id: string; decay_score: string }[]) {
      byEmployee[row.employee_id] = Number(row.decay_score);
    }
    return byEmployee;
  };

  it('a run interrupted after one batch leaves the checkpoint at that batch, decaying only those employees', async () => {
    await skillDecayJobService.runForTenant(tenantId, runDate, { batchSize: 2, maxBatches: 1 });

    const run = await fetchRun();
    expect(run?.status).toBe(DecayJobRunStatus.RUNNING);
    expect(run?.employees_processed).toBe(2);
    expect(run?.last_processed_employee_id).toBe(employeeIds[1]);

    const scores = await fetchDecayScores();
    expect(scores[employeeIds[0]]).toBeLessThan(1);
    expect(scores[employeeIds[1]]).toBeLessThan(1);
    // Not yet reached by the interrupted run - still at the column default.
    expect(scores[employeeIds[2]]).toBe(1);
    expect(scores[employeeIds[3]]).toBe(1);
    expect(scores[employeeIds[4]]).toBe(1);
  });

  it('resuming completes the run without reprocessing already-decayed employees, and the decay formula is correct', async () => {
    const scoresBeforeResume = await fetchDecayScores();

    await skillDecayJobService.runForTenant(tenantId, runDate, { batchSize: 2 });

    const run = await fetchRun();
    expect(run?.status).toBe(DecayJobRunStatus.COMPLETED);
    // 2 (first call) + 3 (resumed: employees 3,4,5 across two more batches) = 5.
    expect(run?.employees_processed).toBe(5);

    const scoresAfterResume = await fetchDecayScores();
    // The first two employees' scores are untouched by the resumed run - the
    // cursor started strictly after them, so their decay_score is exactly
    // what the interrupted run already computed, not recomputed a second time.
    expect(scoresAfterResume[employeeIds[0]]).toBe(scoresBeforeResume[employeeIds[0]]);
    expect(scoresAfterResume[employeeIds[1]]).toBe(scoresBeforeResume[employeeIds[1]]);

    for (const id of employeeIds) {
      // exp(-ln(2)/180 * 180) = exp(-ln 2) = 0.5, for every employee's
      // 180-day-old anchor - same formula, same input, same result.
      expect(scoresAfterResume[id]).toBeCloseTo(0.5, 1);
    }
  });

  it('running again after completion is a no-op (idempotent)', async () => {
    const scoresBefore = await fetchDecayScores();

    await skillDecayJobService.runForTenant(tenantId, runDate, { batchSize: 2 });

    const run = await fetchRun();
    expect(run?.status).toBe(DecayJobRunStatus.COMPLETED);
    expect(run?.employees_processed).toBe(5);

    const scoresAfter = await fetchDecayScores();
    expect(scoresAfter).toEqual(scoresBefore);
  });
});
