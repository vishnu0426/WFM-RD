import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';

/**
 * ADR-0023: bcrypt (via `bcryptjs`, a pure-JS implementation - chosen over
 * the native `bcrypt`/`argon2` packages specifically to avoid a native
 * build-toolchain dependency for local dev/CI portability, flagged as a
 * trade-off worth revisiting for a managed KDF or a properly toolchain-
 * supported native build before production, see the readiness checklist).
 * Cost factor is configurable (`PASSWORD_HASH_COST_FACTOR`) so CI can use a
 * cheap value (fast tests) while a real deployment tunes for ~250ms/verify
 * on production-class hardware.
 */
@Injectable()
export class PasswordHasherService {
  private readonly costFactor: number;

  constructor(config: ConfigService) {
    // ConfigService.get<number>(...) doesn't actually cast - env vars are
    // always strings, and the <number> generic is compile-time only. Without
    // Number(...), a real "12" from .env reaches bcrypt.genSalt as the
    // string "12", which throws ("illegal arguments: string") rather than
    // silently doing the wrong thing - this was never exercised at runtime
    // before (every existing caller either only verifies, or seeds via a
    // direct bcryptjs call, not this service).
    this.costFactor = Number(config.get('PASSWORD_HASH_COST_FACTOR', 12));
  }

  async hash(plaintext: string): Promise<string> {
    const salt = await bcrypt.genSalt(this.costFactor);
    return bcrypt.hash(plaintext, salt);
  }

  async verify(plaintext: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plaintext, hash);
  }
}
