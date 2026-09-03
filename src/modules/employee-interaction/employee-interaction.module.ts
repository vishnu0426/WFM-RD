import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmployeeInteraction } from './entities/employee-interaction.entity';
import { OrgUnitInteractionSettings } from './entities/org-unit-interaction-settings.entity';
import { EmployeeInteractionsRepository } from './repositories/employee-interactions.repository';
import { OrgUnitInteractionSettingsRepository } from './repositories/org-unit-interaction-settings.repository';
import { EmployeeInteractionsService } from './services/employee-interactions.service';
import { OrgUnitInteractionSettingsService } from './services/org-unit-interaction-settings.service';
import {
  EmployeeInteractionResolver,
  EmployeeInteractionsFieldResolver,
} from './graphql/employee-interaction.resolver';
import { OrgUnitInteractionSettingsResolver } from './graphql/org-unit-interaction-settings.resolver';
import { EmployeeModule } from '../employee/employee.module';
import { OrgUnitModule } from '../org-unit/org-unit.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([EmployeeInteraction, OrgUnitInteractionSettings]),
    EmployeeModule,
    OrgUnitModule,
    AuthModule,
    AuditModule,
  ],
  providers: [
    EmployeeInteractionsRepository,
    OrgUnitInteractionSettingsRepository,
    EmployeeInteractionsService,
    OrgUnitInteractionSettingsService,
    EmployeeInteractionResolver,
    EmployeeInteractionsFieldResolver,
    OrgUnitInteractionSettingsResolver,
  ],
  exports: [TypeOrmModule, EmployeeInteractionsRepository, EmployeeInteractionsService],
})
export class EmployeeInteractionModule {}
