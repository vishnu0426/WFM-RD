import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmployeeSchedulePreference } from './entities/employee-schedule-preference.entity';
import { EmployeeSchedulePreferencesRepository } from './repositories/employee-schedule-preferences.repository';
import { EmployeeSchedulePreferencesService } from './services/employee-schedule-preferences.service';
import {
  EmployeeSchedulePreferenceResolver,
  EmployeeSchedulePreferenceFieldResolver,
} from './graphql/employee-schedule-preference.resolver';
import { EmployeeModule } from '../employee/employee.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([EmployeeSchedulePreference]), EmployeeModule, AuthModule, AuditModule],
  providers: [
    EmployeeSchedulePreferencesRepository,
    EmployeeSchedulePreferencesService,
    EmployeeSchedulePreferenceResolver,
    EmployeeSchedulePreferenceFieldResolver,
  ],
  exports: [TypeOrmModule, EmployeeSchedulePreferencesRepository, EmployeeSchedulePreferencesService],
})
export class SchedulePreferenceModule {}
