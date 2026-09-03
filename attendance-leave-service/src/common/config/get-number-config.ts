import { ConfigService } from '@nestjs/config';

/**
 * `ConfigService.get<number>(key, default)` does **not** cast at runtime -
 * the `<number>` is a TypeScript type hint only. When `key` is actually set
 * (an env var, always a string), the returned value is that raw string,
 * silently typed as `number` to the caller. This is invisible whenever a
 * call site only ever exercises its literal default (a real JS number) -
 * exactly how this bug went undetected through Phases 2-4's own unit
 * tests, which construct `ConfigService` from object literals holding real
 * numbers, never from string-valued env vars the way a real deployment
 * would.
 *
 * Caught for real in Phase 4's real-Redis verification: `LEAVE_APPROVAL_REMINDER_DELAY_MS`
 * set as a shell env var flowed into `Queue.add(..., { delay: "3000" })` -
 * BullMQ's `delay` option does arithmetic on it internally
 * (`+`, not a coercing comparison), so a string delay fires the job almost
 * immediately instead of respecting the configured wait. Every
 * `config.get<number>(...)` call site in this service (both here and in
 * `AttendanceExceptionDetectionService`'s grace-period thresholds, Phase 2)
 * is a latent instance of the same bug - grace-period comparisons happened
 * to still work by accident (`>`/`<` *do* coerce a string operand), which
 * is exactly why this class of bug is dangerous: some call sites fail
 * loudly, some fail silently correct until a future edit changes the
 * operator.
 *
 * Use this helper at every numeric-config call site instead of
 * `config.get<number>(...)` directly.
 */
export function getNumberConfig(config: ConfigService, key: string, defaultValue: number): number {
  const raw = config.get<string | number>(key);
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue;
  }
  return Number(raw);
}
