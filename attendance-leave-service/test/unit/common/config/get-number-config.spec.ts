import { ConfigService } from '@nestjs/config';
import { getNumberConfig } from '../../../../src/common/config/get-number-config';

/**
 * The regression test for the bug this helper exists to prevent: a real
 * env var is always a string (`process.env`), and
 * `ConfigService.get<number>(key, default)` does not cast it - only
 * `Number(...)`-ing the result does. `new ConfigService({ KEY: 10 })`
 * (a literal JS number) would NOT have caught this - it has to be a
 * string value, the way `ConfigModule.forRoot()` actually loads `.env`,
 * to reproduce what broke BullMQ's `delay` option in Phase 4's
 * real-Redis verification (see this helper's own doc comment).
 */
describe('getNumberConfig', () => {
  it('casts a string-valued env var to a real number', () => {
    const config = new ConfigService({ SOME_DELAY_MS: '3000' });
    const value = getNumberConfig(config, 'SOME_DELAY_MS', 600_000);
    expect(value).toBe(3000);
    expect(typeof value).toBe('number');
  });

  it('returns the default (as a real number) when the key is unset', () => {
    const config = new ConfigService({});
    const value = getNumberConfig(config, 'SOME_DELAY_MS', 600_000);
    expect(value).toBe(600_000);
    expect(typeof value).toBe('number');
  });

  it('passes through an already-numeric value unchanged', () => {
    const config = new ConfigService({ SOME_DELAY_MS: 3000 });
    expect(getNumberConfig(config, 'SOME_DELAY_MS', 600_000)).toBe(3000);
  });

  it('demonstrates the actual failure mode this helper prevents: a raw string added to Date.now() concatenates instead of adding', () => {
    const config = new ConfigService({ SOME_DELAY_MS: '3000' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken = config.get<number>('SOME_DELAY_MS', 600_000) as any;
    expect(typeof broken).toBe('string'); // the bug: still a string at runtime despite the <number> type hint
    expect(Date.now() + broken).not.toEqual(Date.now() + 3000); // string concatenation, not arithmetic

    const fixed = getNumberConfig(config, 'SOME_DELAY_MS', 600_000);
    expect(typeof fixed).toBe('number');
  });
});
