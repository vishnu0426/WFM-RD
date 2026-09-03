import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ErasureRequestsService } from '../services/erasure-requests.service';
import { CreateErasureRequestInput } from '../dto/create-erasure-request.input';
import { ErasureRequest } from '../entities/erasure-request.entity';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/**
 * §3.2's `POST /v1/employees/{id}/erasure-requests`. §3.2 doesn't spell out
 * the approve/reject/complete routes explicitly (only creation) - they're
 * added here because a create-only REST surface would leave no way to
 * progress a request outside GraphQL, and the same lifecycle already exists
 * as `approveErasureRequest`/`rejectErasureRequest`/`completeErasureRequest`
 * mutations (see `ErasureRequestResolver`'s doc comment for why these are
 * separate actions, not a generic status setter).
 *
 * Gated for the first time here (frontend Phase 1 prerequisite) - same
 * `employee:write`/`employee:approve` split as the GraphQL resolver.
 */
@Controller('v1')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class ErasureRequestsController {
  constructor(private readonly erasureRequestsService: ErasureRequestsService) {}

  @Post('employees/:id/erasure-requests')
  @RequirePermissions('employee:write')
  async create(@Param('id') employeeId: string, @Body() input: CreateErasureRequestInput): Promise<ErasureRequest> {
    return this.erasureRequestsService.create(employeeId, input.legalBasis);
  }

  @Get('erasure-requests/:id')
  @RequirePermissions('employee:read')
  async get(@Param('id') id: string): Promise<ErasureRequest> {
    return this.erasureRequestsService.findById(id);
  }

  @Post('erasure-requests/:id/approve')
  @RequirePermissions('employee:approve')
  async approve(@Param('id') id: string): Promise<ErasureRequest> {
    return this.erasureRequestsService.approve(id);
  }

  @Post('erasure-requests/:id/reject')
  @RequirePermissions('employee:approve')
  async reject(@Param('id') id: string): Promise<ErasureRequest> {
    return this.erasureRequestsService.reject(id);
  }

  @Post('erasure-requests/:id/complete')
  @RequirePermissions('employee:approve')
  async complete(@Param('id') id: string): Promise<ErasureRequest> {
    return this.erasureRequestsService.complete(id);
  }
}
