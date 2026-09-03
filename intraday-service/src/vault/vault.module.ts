import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import vaultConfig from './vault.config';
import { VaultClientService } from './vault-client.service';

@Module({
  imports: [ConfigModule.forFeature(vaultConfig)],
  providers: [VaultClientService],
  exports: [VaultClientService],
})
export class VaultModule {}
