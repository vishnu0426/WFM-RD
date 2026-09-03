import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TenantContextService } from '../tenant/tenant-context.service';
import { PoliciesRepository } from '../../modules/policy/repositories/policies.repository';
import { PolicyType } from '../../modules/policy/entities/policy-type.enum';

interface MaintenanceModeDefinition {
  enabled?: boolean;
  message?: string;
}

/**
 * System Configuration's "Maintenance Mode" setting — genuinely rejects
 * non-GET requests for a tenant in maintenance, not a UI-only banner.
 * Registered in `app.module.ts`'s `configure()` AFTER `TenantContextMiddleware`
 * (needs tenant context already bound to know which tenant's policy to
 * check) — same global-middleware shape as `TenantContextMiddleware` itself,
 * see that class's own doc comment for why Express middleware (not a Nest
 * guard) is the right layer here too.
 *
 * Fails open by design at every uncertain point: no bound tenant context
 * (pre-auth endpoints), no policy row, or a lookup error all let the
 * request through — a maintenance-mode bug must never itself become an
 * outage. `platform_admin` always bypasses (emergency escape hatch, same
 * posture as every other platform_admin bypass in this codebase).
 */
@Injectable()
export class MaintenanceModeMiddleware implements NestMiddleware {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly policiesRepository: PoliciesRepository,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    const store = this.tenantContext.getStore();
    if (!store?.tenantId || store.isPlatformAdmin) {
      next();
      return;
    }
    try {
      const policy = await this.policiesRepository.findActiveByType(PolicyType.MAINTENANCE_MODE, new Date());
      const definition = policy?.definition as MaintenanceModeDefinition | undefined;
      if (definition?.enabled) {
        res.status(503).json({
          error: {
            code: 'TENANT_IN_MAINTENANCE',
            message: definition.message || 'This tenant is currently in maintenance mode. Please try again later.',
            details: null,
          },
        });
        return;
      }
    } catch {
      // Fail open — see class doc comment.
    }
    next();
  }
}
