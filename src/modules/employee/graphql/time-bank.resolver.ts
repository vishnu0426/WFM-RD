import { UseGuards } from '@nestjs/common';
import { Args, Context, Float, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { TimeBankEntryType } from './time-bank-entry.type';
import { TimeBankEntriesRepository } from '../repositories/time-bank-entries.repository';
import { TimeBankEntry } from '../entities/time-bank-entry.entity';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

/**
 * "Time Banks" in the reference console's own menu — a banked/comp-time
 * ledger per employee. Reuses `employee:read`/`employee:write` rather than
 * a new permission resource: this is employee-scoped HR data at the exact
 * same trust boundary as the `Employee` record itself, same reasoning
 * `EmployeeSkillsResolver` already applies for skill assignments.
 */
@Resolver(() => TimeBankEntryType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class TimeBankResolver {
  constructor(
    private readonly timeBankEntries: TimeBankEntriesRepository,
    private readonly auditLog: AuditLogRepository,
  ) {}

  @Query(() => [TimeBankEntryType], { name: 'timeBankEntries' })
  @RequirePermissions('employee:read')
  async listTimeBankEntries(@Args('employeeId', { type: () => ID }) employeeId: string): Promise<TimeBankEntryType[]> {
    const rows = await this.timeBankEntries.findByEmployee(employeeId);
    return rows.map(toTimeBankEntryType);
  }

  @Query(() => Float)
  @RequirePermissions('employee:read')
  async timeBankBalance(@Args('employeeId', { type: () => ID }) employeeId: string): Promise<number> {
    return Number(await this.timeBankEntries.balanceForEmployee(employeeId));
  }

  @Mutation(() => TimeBankEntryType)
  @RequirePermissions('employee:write')
  async addTimeBankEntry(
    @Context() context: { req: RequestWithTokenClaims },
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Args('hours', { type: () => Float }) hours: number,
    @Args('reason') reason: string,
    @Args('entryDate') entryDate: string,
  ): Promise<TimeBankEntryType> {
    const claims = context.req.tokenClaims!;
    const entry = await this.timeBankEntries.create({
      employeeId,
      hours: hours.toString(),
      reason,
      entryDate,
      createdBy: claims.sub,
    });
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'employee.time_bank_entry_added',
      resourceType: 'employee',
      resourceId: employeeId,
      beforeState: null,
      afterState: { hours, reason, entryDate },
      aiRationale: null,
    });
    return toTimeBankEntryType(entry);
  }
}

/** `hours` is a TypeORM `numeric` column, returned as `string` — GraphQL's `Float` needs a real number. */
function toTimeBankEntryType(entry: TimeBankEntry): TimeBankEntryType {
  return { ...entry, hours: Number(entry.hours) };
}
