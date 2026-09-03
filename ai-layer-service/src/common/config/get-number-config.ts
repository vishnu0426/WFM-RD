import { ConfigService } from '@nestjs/config';

/**
 * Own copy of the platform's `get-number-config.ts` -
 * `ConfigService.get<number>(key, default)` does **not** cast at runtime;
 * when `key` is actually set (an env var, always a string), the returned
 * value is that raw string, silently typed as `number` to the caller. Use
 * this helper at every numeric-config call site instead of
 * `config.get<number>(...)` directly.
 */
export function getNumberConfig(config: ConfigService, key: string, defaultValue: number): number {
  const raw = config.get<string | number>(key);
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue;
  }
  return Number(raw);
}
