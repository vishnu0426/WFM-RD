import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ReallocationNotFoundError } from '../common/errors/reallocation-not-found.error';
import { ReallocationNotSuggestedError } from '../common/errors/reallocation-not-suggested.error';
import { withTenantConnection } from '../database/with-tenant-connection';
import { ReallocationAction } from './entities/reallocation-action.entity';
import { ReallocationExecutionService } from './reallocation-execution.service';

/**
 * `approveReallocation` (§4.1) / `POST /v1/intraday/reallocations/:id/approve`
 * (§4.2). §4 exposes no separate "execute" step anywhere - approving is
 * the only action a supervisor can take, so it has to be what causes
 * execution, not a distinct later step (design doc assumption 5):
 * `suggested` → `approved` → `executed`, all in this one call.
 */
@Injectable()
export class ReallocationApprovalService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly execution: ReallocationExecutionService,
  ) {}

  async approve(tenantId: string, reallocationId: string): Promise<ReallocationAction> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const repository = manager.getRepository(ReallocationAction);
      // GAP-10 fix (enterprise readiness audit, 2026-08-18): the previous
      // plain `findOne` took no row lock, so two concurrent `approve()`
      // calls for the same reallocation could both read status='suggested',
      // both pass the check below, and both execute -
      // `ReallocationExecutionService.applyReallocation`'s Redis writes and
      // the resulting NATS handoff would each run twice. `setLock('pessimistic_write')`
      // (a real `SELECT ... FOR UPDATE`) forces the second concurrent call
      // to block until the first transaction commits, then re-read the row
      // under its own lock - it sees `status='executed'` and correctly
      // throws `ReallocationNotSuggestedError` instead of racing through.
      // Same pattern already proven in attendance-leave-service's
      // `decide-leave-request.service.ts` for the identical "read status,
      // act once" shape.
      const action = await manager
        .createQueryBuilder(ReallocationAction, 'action')
        .setLock('pessimistic_write')
        .where('action.tenantId = :tenantId', { tenantId })
        .andWhere('action.id = :id', { id: reallocationId })
        .getOne();
      if (!action) {
        throw new ReallocationNotFoundError(reallocationId);
      }
      if (action.status !== 'suggested') {
        throw new ReallocationNotSuggestedError(reallocationId, action.status);
      }

      action.status = 'approved';
      await repository.save(action);

      await this.execution.applyReallocation(
        tenantId,
        action.fromQueueId,
        action.toQueueId,
        action.affectedEmployeeIds,
      );

      action.status = 'executed';
      action.executedAt = new Date();
      await repository.save(action);
      return action;
    });
  }
}
