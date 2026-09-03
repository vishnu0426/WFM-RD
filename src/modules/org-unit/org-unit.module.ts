import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrgUnit } from './entities/org-unit.entity';
import { OrgUnitHistory } from './entities/org-unit-history.entity';
import { OrgUnitsRepository } from './repositories/org-units.repository';
import { OrgUnitHistoryRepository } from './repositories/org-unit-history.repository';
import { OrgUnitsService } from './services/org-units.service';
import { OrgHierarchyService } from './services/org-hierarchy.service';
import { SystemLimitsModule } from '../policy/system-limits.module';

@Module({
  imports: [TypeOrmModule.forFeature([OrgUnit, OrgUnitHistory]), SystemLimitsModule],
  providers: [OrgUnitsRepository, OrgUnitHistoryRepository, OrgUnitsService, OrgHierarchyService],
  exports: [TypeOrmModule, OrgUnitsRepository, OrgUnitHistoryRepository, OrgUnitsService, OrgHierarchyService],
})
export class OrgUnitModule {}
