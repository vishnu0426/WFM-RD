import { registerAs } from '@nestjs/config';

export interface VaultConfig {
  addr: string;
  token: string;
  kvMount: string;
}

/**
 * §1/ADR-0134: this module's central security primitive. `VAULT_ADDR`/
 * `VAULT_TOKEN` have no hardcoded fallback (unlike `DB_PASSWORD`'s
 * `changeme_local_only` local-dev default) - a missing Vault configuration
 * must be a loud boot-time-or-first-use failure, never a silent connection
 * to nothing. `kvMount` defaults to `secret` (Vault's own KV v2 dev-mode
 * default mount), overridable for a real deployment's own mount naming.
 */
export default registerAs('vault', (): VaultConfig => ({
  addr: process.env.VAULT_ADDR ?? '',
  token: process.env.VAULT_TOKEN ?? '',
  kvMount: process.env.VAULT_KV_MOUNT ?? 'secret',
}));
