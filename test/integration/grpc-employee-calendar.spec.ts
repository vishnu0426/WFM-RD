import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { join } from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
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
import { WorkingTimeCalendar } from '../../src/modules/calendar/entities/working-time-calendar.entity';

dotenv.config();

const GRPC_URL = '127.0.0.1:50551';
const PROTO_PATHS = [
  join(__dirname, '../../src/grpc/proto/employee.proto'),
  join(__dirname, '../../src/grpc/proto/calendar.proto'),
];

interface SchedulableEmployeeMessage {
  employeeId: string;
  employeeNumber: string;
}

interface SkillMatrixEntry {
  employeeId: string;
  skillId: string;
  decayScore: number;
}

interface WorkingTimeRulesMessage {
  timezone: string;
  holidayDates: string[];
}

/**
 * §3.3's gRPC surface, "contract-tested against a mock Module 04 consumer"
 * (§8 Phase 7) - this test *is* that mock consumer: a raw `@grpc/grpc-js`
 * client with no NestJS involvement on the calling side, connecting to the
 * real running microservice exactly as Scheduling/Forecasting would.
 */
describe('gRPC EmployeeService/CalendarService (contract test against a real client)', () => {
  let app: INestApplication;
  let migratorDataSource: DataSource;
  let employeeClient: grpc.Client & {
    getSchedulableEmployees: (req: unknown) => grpc.ClientReadableStream<SchedulableEmployeeMessage>;
    getEmployeeSkillMatrix: (
      req: unknown,
      cb: (err: grpc.ServiceError | null, res: { entries: SkillMatrixEntry[] }) => void,
    ) => void;
  };
  let calendarClient: grpc.Client & {
    getWorkingTimeRules: (
      req: unknown,
      cb: (err: grpc.ServiceError | null, res: WorkingTimeRulesMessage) => void,
    ) => void;
  };
  let tenantId: string;
  let orgUnitId: string;
  let skillId: string;
  let skilledEmployeeId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: { package: 'agno.org.v1', protoPath: PROTO_PATHS, url: GRPC_URL },
    });
    await app.startAllMicroservices();
    await app.init();

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
        name: `gRPC Test Tenant ${uuidv4()}`,
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
        name: 'gRPC Test Site',
        timezone: 'America/Chicago',
        countryCode: 'US',
        status: OrgUnitStatus.ACTIVE,
      }),
    );
    orgUnitId = orgUnit.id;

    const skill = await migratorDataSource.getRepository(Skill).save(
      migratorDataSource.getRepository(Skill).create({
        tenantId,
        name: `gRPC Required Skill ${uuidv4()}`,
        category: 'test',
        requiresCertification: false,
        certificationValidityDays: null,
      }),
    );
    skillId = skill.id;

    const employeeRepo = migratorDataSource.getRepository(Employee);
    const employeeSkillRepo = migratorDataSource.getRepository(EmployeeSkill);

    const skilled = await employeeRepo.save(
      employeeRepo.create({
        id: uuidv4(),
        tenantId,
        userId: null,
        orgUnitId,
        employeeNumber: `G-SK-${uuidv4()}`,
        employmentType: EmploymentType.FULL_TIME,
        contractHoursPerWeek: '40.00',
        hireDate: '2024-01-01',
        terminationDate: null,
        costCenter: null,
        managerEmployeeId: null,
        status: EmployeeStatus.ACTIVE,
      }),
    );
    skilledEmployeeId = skilled.id;
    await employeeSkillRepo.save(
      employeeSkillRepo.create({
        tenantId,
        employeeId: skilled.id,
        skillId: skill.id,
        proficiencyLevel: ProficiencyLevel.EXPERT,
        certifiedDate: null,
        lastScheduledOnSkillAt: null,
      }),
    );

    // Active but missing the required skill - must NOT appear when the skill is required.
    await employeeRepo.save(
      employeeRepo.create({
        id: uuidv4(),
        tenantId,
        userId: null,
        orgUnitId,
        employeeNumber: `G-UN-${uuidv4()}`,
        employmentType: EmploymentType.FULL_TIME,
        contractHoursPerWeek: '40.00',
        hireDate: '2024-01-01',
        terminationDate: null,
        costCenter: null,
        managerEmployeeId: null,
        status: EmployeeStatus.ACTIVE,
      }),
    );

    // Terminated - must never appear regardless of skills.
    await employeeRepo.save(
      employeeRepo.create({
        id: uuidv4(),
        tenantId,
        userId: null,
        orgUnitId,
        employeeNumber: `G-TR-${uuidv4()}`,
        employmentType: EmploymentType.FULL_TIME,
        contractHoursPerWeek: '40.00',
        hireDate: '2020-01-01',
        terminationDate: '2025-01-01',
        costCenter: null,
        managerEmployeeId: null,
        status: EmployeeStatus.TERMINATED,
      }),
    );

    await migratorDataSource.getRepository(WorkingTimeCalendar).save(
      migratorDataSource.getRepository(WorkingTimeCalendar).create({
        tenantId,
        orgUnitId,
        countryCode: 'US',
        timezone: 'America/Chicago',
        holidayDates: ['2026-01-01', '2026-06-15', '2026-12-25'],
        standardBusinessHours: { mon: ['09:00', '17:00'] },
      }),
    );

    const packageDefinition = protoLoader.loadSync(PROTO_PATHS, { keepCase: false, longs: String, defaults: true });
    const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
      agno: {
        org: { v1: { EmployeeService: grpc.ServiceClientConstructor; CalendarService: grpc.ServiceClientConstructor } };
      };
    };
    employeeClient = new proto.agno.org.v1.EmployeeService(GRPC_URL, grpc.credentials.createInsecure()) as never;
    calendarClient = new proto.agno.org.v1.CalendarService(GRPC_URL, grpc.credentials.createInsecure()) as never;
  });

  afterAll(async () => {
    // Defensive: if beforeAll threw partway through (e.g. a seed-data
    // validation error) these may never have been assigned - guard so
    // cleanup still runs for whatever *did* get created, rather than
    // throwing here too and leaking the gRPC server/DB connections for the
    // rest of the Jest process's lifetime (this is exactly what happened
    // before this guard existed - see the git history for this file).
    employeeClient?.close();
    calendarClient?.close();
    await app?.close();
    await migratorDataSource?.destroy();
  });

  it('GetSchedulableEmployees streams only active employees in the org unit holding the required skill', async () => {
    const results: SchedulableEmployeeMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      const call = employeeClient.getSchedulableEmployees({
        tenantId,
        orgUnitId,
        requiredSkillIds: [skillId],
        minContractHoursPerWeek: 0,
        pageSize: 10,
      });
      call.on('data', (chunk) => results.push(chunk));
      call.on('end', () => resolve());
      call.on('error', (err) => reject(err));
    });

    expect(results).toHaveLength(1);
    expect(results[0].employeeId).toBe(skilledEmployeeId);
  });

  it('GetSchedulableEmployees with no skill requirement returns every active employee in the org unit, still excluding terminated', async () => {
    const results: SchedulableEmployeeMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      // pageSize: 1 forces the server to page internally across multiple stream chunks.
      const call = employeeClient.getSchedulableEmployees({
        tenantId,
        orgUnitId,
        requiredSkillIds: [],
        minContractHoursPerWeek: 0,
        pageSize: 1,
      });
      call.on('data', (chunk) => results.push(chunk));
      call.on('end', () => resolve());
      call.on('error', (err) => reject(err));
    });

    expect(results).toHaveLength(2);
    expect(results.some((r) => r.employeeNumber.startsWith('G-TR'))).toBe(false);
  });

  it('GetEmployeeSkillMatrix returns a sparse entry only for the employee/skill pair that exists', async () => {
    const response = await new Promise<{ entries: SkillMatrixEntry[] }>((resolve, reject) => {
      employeeClient.getEmployeeSkillMatrix({ tenantId, employeeIds: [skilledEmployeeId] }, (err, res) =>
        err ? reject(err) : resolve(res),
      );
    });

    expect(response.entries).toHaveLength(1);
    expect(response.entries[0].employeeId).toBe(skilledEmployeeId);
    expect(response.entries[0].decayScore).toBeGreaterThan(0);
  });

  it('GetWorkingTimeRules returns the org unit calendar filtered to the requested date range', async () => {
    const response = await new Promise<WorkingTimeRulesMessage>((resolve, reject) => {
      calendarClient.getWorkingTimeRules(
        { tenantId, orgUnitId, fromDate: '2026-01-01', toDate: '2026-06-30' },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
    });

    expect(response.timezone).toBe('America/Chicago');
    expect(response.holidayDates).toEqual(['2026-01-01', '2026-06-15']);
  });
});
