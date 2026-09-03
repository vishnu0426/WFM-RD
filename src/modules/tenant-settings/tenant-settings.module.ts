import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantSettings } from './entities/tenant-settings.entity';
import { TenantSettingsRepository } from './repositories/tenant-settings.repository';
import { TenantSettingsService } from './tenant-settings.service';

@Module({
  imports: [TypeOrmModule.forFeature([TenantSettings])],
  providers: [TenantSettingsRepository, TenantSettingsService],
  exports: [TypeOrmModule, TenantSettingsRepository, TenantSettingsService],
})
export class TenantSettingsModule {}
