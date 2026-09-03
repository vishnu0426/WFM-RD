import { ConfigService } from '@nestjs/config';

/**
 * Own copy of attendance-leave-service's `get-number-config.ts` -
 * `ConfigService.get<number>(key, default)` does **not** cast at runtime;
 * when `key` is actually set (an env var, always a string), the returned
 * value is that raw string, silently typed as `number` to the caller. That
 * service's own doc comment documents a real bug this exact gap caused in
 * a BullMQ delay computation - use this helper at every numeric-config call
 * site instead of `config.get<number>(...)` directly.
 */
export function getNumberConfig(config: ConfigService, key: string, defaultValue: number): number {
  const raw = config.get<string | number>(key);
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue;
  }
  return Number(raw);
}
