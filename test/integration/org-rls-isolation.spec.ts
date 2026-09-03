import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { entities, Tenant } from '../../src/modules/entities';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { OrgUnitsRepository } from '../../src/modules/org-unit/repositories/org-units.repository';
import { OrgUnitHistoryRepository } from '../../src/modules/org-unit/repositories/org-unit-history.repository';
import { OrgUnit } from '../../src/modules/org-unit/entities/org-unit.entity';
import { OrgUnitType } from '../../src/modules/org-unit/entities/org-unit-type.enum';
import { OrgUnitStatus } from '../../src/modules/org-unit/entities/org-unit-status.enum';
import { EmployeesRepository } from '../../src/modules/employee/repositories/employees.repository';
import { EmployeeHistoryRepository } from '../../src/modules/employee/repositories/employee-history.repository';
import { Employee } from '../../src/modules/employee/entities/employee.entity';
import { EmploymentType } from '../../src/modules/employee/entities/employment-type.enum';
import { EmployeeStatus } from '../../src/modules/employee/entities/employee-status.enum';
import { SkillsRepository } from '../../src/modules/skill/repositories/skills.repository';
import { EmployeeSkillsRepository } from '../../src/modules/skill/repositories/employee-skills.repository';
import { Skill } from '../../src/modules/skill/entities/skill.entity';
import { EmployeeSkill } from '../../src/modules/skill/entities/employee-skill.entity';
import { ProficiencyLevel } from '../../src/modules/skill/entities/proficiency-level.enum';
import { EmploymentPoliciesRepository } from '../../src/modules/policy/repositories/employment-policies.repository';
import { Policy } from '../../src/modules/policy/entities/policy.entity';
import { PolicyType } from '../../src/modules/policy/entities/policy-type.enum';

dotenv.config();

/**
 * Requires a reachable Postgres with both migrations already applied
 * (docker-compose up -d && npm run migration:run). Module 02 counterpart to
 * Module 01's test/integration/rls-isolation.spec.ts - exercises the org.*
 * RLS policies, the ltree subtree read (ADR-0008), SCD Type 2 history
 * versioning + its append-only grant (ADR-0009), the composite-FK
 * tenant-consistency guarantee (ADR-0010), the EmployeeSkill expiry trigger,
 * and the core.policies extension backing EmploymentPolicy (ADR-0012).
 */
describe('Org & Employee module (application guard + Postgres RLS + triggers)', () => {
  let appDataSource: DataSource;
  let migratorDataSource: DataSource;
  let tenantContext: TenantContextService;
  let orgUnitsRepository: OrgUnitsRepository;
  let orgUnitHistoryRepository: OrgUnitHistoryRepository;
  let employeesRepository: EmployeesRepository;
  let employeeHistoryRepository: EmployeeHistoryRepository;
  let skillsRepository: SkillsRepository;
  let employeeSkillsRepository: EmployeeSkillsRepository;
  let employmentPoliciesRepository: EmploymentPoliciesRepository;

  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await appDataSource.initialize();

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

    tenantContext = new TenantContextService();
    orgUnitsRepository = new OrgUnitsRepository(appDataSource, tenantContext);
    orgUnitHistoryRepository = new OrgUnitHistoryRepository(appDataSource, tenantContext);
    employeesRepository = new EmployeesRepository(appDataSource, tenantContext);
    employeeHistoryRepository = new EmployeeHistoryRepository(appDataSource, tenantContext);
    skillsRepository = new SkillsRepository(appDataSource, tenantContext);
    employeeSkillsRepository = new EmployeeSkillsRepository(appDataSource, tenantContext);
    employmentPoliciesRepository = new EmploymentPoliciesRepository(appDataSource, tenantContext);

    const migratorTenantRepo = migratorDataSource.getRepository(Tenant);
    const tenantA = await migratorTenantRepo.save(
      migratorTenantRepo.create({
        name: `Org Test Tenant A ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    const tenantB = await migratorTenantRepo.save(
      migratorTenantRepo.create({
        name: `Org Test Tenant B ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  const makeOrgUnit = (tenantId: string, parentOrgUnitId: string | null, name: string): Partial<OrgUnit> => ({
    tenantId,
    parentOrgUnitId,
    type: OrgUnitType.BUSINESS_UNIT,
    name,
    timezone: 'UTC',
    countryCode: 'US',
    status: OrgUnitStatus.ACTIVE,
  });

  it("a tenant's OrgUnit view only returns that tenant's rows (RLS)", async () => {
    const rootA = await tenantContext.run({ tenantId: tenantAId }, () =>
      orgUnitsRepository.save(makeOrgUnit(tenantAId, null, `Root A ${uuidv4()}`) as OrgUnit),
    );
    const rootB = await tenantContext.run({ tenantId: tenantBId }, () =>
      orgUnitsRepository.save(makeOrgUnit(tenantBId, null, `Root B ${uuidv4()}`) as OrgUnit),
    );

    const seenByA = await tenantContext.run({ tenantId: tenantAId }, () => orgUnitsRepository.findRoots());
    expect(seenByA.map((o) => o.id)).toContain(rootA.id);
    expect(seenByA.map((o) => o.id)).not.toContain(rootB.id);
  });

  it('the ltree subtree read returns descendants at any depth (ADR-0008)', async () => {
    const root = await tenantContext.run({ tenantId: tenantAId }, () =>
      orgUnitsRepository.save(makeOrgUnit(tenantAId, null, `Subtree Root ${uuidv4()}`) as OrgUnit),
    );
    const dept = await tenantContext.run({ tenantId: tenantAId }, () =>
      orgUnitsRepository.save(makeOrgUnit(tenantAId, root.id, `Subtree Dept ${uuidv4()}`) as OrgUnit),
    );
    const site = await tenantContext.run({ tenantId: tenantAId }, () =>
      orgUnitsRepository.save(makeOrgUnit(tenantAId, dept.id, `Subtree Site ${uuidv4()}`) as OrgUnit),
    );

    const subtree = await tenantContext.run({ tenantId: tenantAId }, () => orgUnitsRepository.findSubtree(root.id));
    const ids = subtree.map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining([root.id, dept.id, site.id]));
  });

  it('an OrgUnit mutation opens a new OrgUnitHistory version and closes the prior one (ADR-0009)', async () => {
    const unit = await tenantContext.run({ tenantId: tenantAId }, () =>
      orgUnitsRepository.save(makeOrgUnit(tenantAId, null, `Versioned Unit ${uuidv4()}`) as OrgUnit),
    );

    const afterInsert = await tenantContext.run({ tenantId: tenantAId }, () =>
      orgUnitHistoryRepository.findHistory(unit.id),
    );
    expect(afterInsert).toHaveLength(1);
    expect(afterInsert[0].validTo).toBeNull();

    await tenantContext.run({ tenantId: tenantAId }, () =>
      orgUnitsRepository.update({ id: unit.id } as never, { name: 'Renamed Unit' } as never),
    );

    const afterUpdate = await tenantContext.run({ tenantId: tenantAId }, () =>
      orgUnitHistoryRepository.findHistory(unit.id),
    );
    expect(afterUpdate).toHaveLength(2);
    expect(afterUpdate[0].validTo).not.toBeNull();
    expect(afterUpdate[1].validTo).toBeNull();
    expect(afterUpdate[1].name).toBe('Renamed Unit');
  });

  it('agno_app cannot write org_unit_history columns other than valid_to (append-only grant, ADR-0009)', async () => {
    // Raw client, not the pooled TypeORM DataSource: talking to Postgres
    // directly as agno_app with no prior session state, same posture as
    // Module 01's analogous audit_log grant test.
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      await expect(rawClient.query('UPDATE org.org_unit_history SET name = $1', ['tampered'])).rejects.toThrow(
        /permission denied/i,
      );
      await expect(rawClient.query('DELETE FROM org.org_unit_history')).rejects.toThrow(/permission denied/i);
    } finally {
      await rawClient.end();
    }
  });

  it("a composite FK rejects an Employee referencing another tenant's OrgUnit (ADR-0010)", async () => {
    const orgUnitB = await tenantContext.run({ tenantId: tenantBId }, () =>
      orgUnitsRepository.save(makeOrgUnit(tenantBId, null, `Cross-tenant Unit ${uuidv4()}`) as OrgUnit),
    );

    await expect(
      tenantContext.run({ tenantId: tenantAId }, () =>
        employeesRepository.create({
          tenantId: tenantAId,
          userId: null,
          orgUnitId: orgUnitB.id,
          employeeNumber: `EMP-${uuidv4()}`,
          employmentType: EmploymentType.FULL_TIME,
          contractHoursPerWeek: '40.00',
          hireDate: '2024-01-01',
          terminationDate: null,
          costCenter: null,
          managerEmployeeId: null,
          status: EmployeeStatus.PENDING_ONBOARDING,
        } as Omit<Employee, 'id' | 'createdAt' | 'updatedAt'>),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('Employee.status changes open a new EmployeeHistory version; unrelated field changes do not (§2.3)', async () => {
    const orgUnit = await tenantContext.run({ tenantId: tenantAId }, () =>
      orgUnitsRepository.save(makeOrgUnit(tenantAId, null, `Employee History Unit ${uuidv4()}`) as OrgUnit),
    );
    const employee = await tenantContext.run({ tenantId: tenantAId }, () =>
      employeesRepository.create({
        tenantId: tenantAId,
        userId: null,
        orgUnitId: orgUnit.id,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: EmploymentType.FULL_TIME,
        contractHoursPerWeek: '40.00',
        hireDate: '2024-01-01',
        terminationDate: null,
        costCenter: 'CC-1',
        managerEmployeeId: null,
        status: EmployeeStatus.PENDING_ONBOARDING,
      } as Omit<Employee, 'id' | 'createdAt' | 'updatedAt'>),
    );

    let history = await tenantContext.run({ tenantId: tenantAId }, () =>
      employeeHistoryRepository.findHistory(employee.id),
    );
    expect(history).toHaveLength(1);

    await tenantContext.run({ tenantId: tenantAId }, () =>
      employeesRepository.update({ id: employee.id } as never, { costCenter: 'CC-2' } as never),
    );
    history = await tenantContext.run({ tenantId: tenantAId }, () =>
      employeeHistoryRepository.findHistory(employee.id),
    );
    expect(history).toHaveLength(1);

    await tenantContext.run({ tenantId: tenantAId }, () =>
      employeesRepository.update({ id: employee.id } as never, { status: EmployeeStatus.ACTIVE } as never),
    );
    history = await tenantContext.run({ tenantId: tenantAId }, () =>
      employeeHistoryRepository.findHistory(employee.id),
    );
    expect(history).toHaveLength(2);
    expect(history[1].status).toBe(EmployeeStatus.ACTIVE);
  });

  it("EmployeeSkill.expiryDate is derived from the skill's certification validity (trigger)", async () => {
    const orgUnit = await tenantContext.run({ tenantId: tenantAId }, () =>
      orgUnitsRepository.save(makeOrgUnit(tenantAId, null, `Skill Test Unit ${uuidv4()}`) as OrgUnit),
    );
    const employee = await tenantContext.run({ tenantId: tenantAId }, () =>
      employeesRepository.create({
        tenantId: tenantAId,
        userId: null,
        orgUnitId: orgUnit.id,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: EmploymentType.FULL_TIME,
        contractHoursPerWeek: '40.00',
        hireDate: '2024-01-01',
        terminationDate: null,
        costCenter: null,
        managerEmployeeId: null,
        status: EmployeeStatus.ACTIVE,
      } as Omit<Employee, 'id' | 'createdAt' | 'updatedAt'>),
    );
    const skill = await tenantContext.run({ tenantId: tenantAId }, () =>
      skillsRepository.save({
        tenantId: tenantAId,
        name: `Certified Skill ${uuidv4()}`,
        category: 'test',
        requiresCertification: true,
        certificationValidityDays: 30,
      } as Skill),
    );

    await tenantContext.run({ tenantId: tenantAId }, () =>
      employeeSkillsRepository.save({
        tenantId: tenantAId,
        employeeId: employee.id,
        skillId: skill.id,
        proficiencyLevel: ProficiencyLevel.PROFICIENT,
        certifiedDate: '2025-01-01',
        lastScheduledOnSkillAt: null,
      } as EmployeeSkill),
    );

    // Re-fetched, not read off the object `.save()` returned: expiryDate is
    // trigger-computed (org.fn_employee_skill_set_expiry), and TypeORM only
    // re-populates columns it tracks as generated (@CreateDateColumn etc.),
    // not a plain @Column a trigger happens to set - the same reasoning
    // behind EmployeesRepository.create() generating `id` client-side.
    const [employeeSkill] = await tenantContext.run({ tenantId: tenantAId }, () =>
      employeeSkillsRepository.findForEmployee(employee.id),
    );
    expect(employeeSkill.expiryDate).toBe('2025-01-31');
  });

  it('EmploymentPolicy (core.policies extension) is org-unit scoped and queryable via EmploymentPoliciesRepository (ADR-0012)', async () => {
    const orgUnit = await tenantContext.run({ tenantId: tenantAId }, () =>
      orgUnitsRepository.save(makeOrgUnit(tenantAId, null, `Policy Test Unit ${uuidv4()}`) as OrgUnit),
    );
    const id = uuidv4();
    await tenantContext.run({ tenantId: tenantAId }, () =>
      employmentPoliciesRepository.save({
        id,
        tenantId: tenantAId,
        policyGroupId: id,
        policyType: PolicyType.OVERTIME_THRESHOLD,
        orgUnitId: orgUnit.id,
        definition: { dailyThresholdHours: 8 },
        effectiveFrom: new Date(),
        effectiveTo: null,
        version: 1,
      } as unknown as Policy),
    );

    const found = await tenantContext.run({ tenantId: tenantAId }, () =>
      employmentPoliciesRepository.findForOrgUnit(orgUnit.id),
    );
    expect(found.map((p) => p.id)).toContain(id);

    const tenantWide = await tenantContext.run({ tenantId: tenantAId }, () =>
      employmentPoliciesRepository.findForOrgUnit(null),
    );
    expect(tenantWide.map((p) => p.id)).not.toContain(id);
  });
});
