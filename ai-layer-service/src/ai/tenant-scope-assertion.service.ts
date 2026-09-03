import { Injectable, Logger } from '@nestjs/common';
import { CrossTenantDataAssemblyError } from '../common/tenant/tenant-context.errors';
import { MetricsService } from '../common/metrics/metrics.service';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';

export interface TenantScopedFact {
  /** Which owning module this fact was pulled from - "scheduling"/"forecasting"/"intraday"/"compliance"/"analytics" (§1). */
  sourceModule: string;
  tenantId: string;
}

/**
 * §5.1's explicit assertion step - "after assembling `input_context` from
 * all gRPC responses and before constructing the LLM call, run a
 * verification pass confirming every piece of assembled data carries the
 * same `tenant_id` as the requesting user - reject and log (as a
 * security-relevant event, not a routine error) if any assembled fact
 * doesn't match."
 *
 * This is deliberately belt-and-suspenders, not the primary tenant
 * boundary: §5.1 is explicit that "the AI Layer does not, and must not,
 * trust its own assembly logic as the tenant boundary" - the owning
 * module's own RLS/ABAC enforcement on its gRPC handler is the actual
 * backstop (defense in depth). What this class catches is specifically a
 * query-router bug that requested the wrong scope in the first place (e.g.
 * a stale/mismatched tenant context threaded into a gRPC call) - every
 * `*GrpcClientService` in this module is expected to echo the tenant id it
 * actually served the request for (not just parrot back the request's own
 * field) so this check has something real to verify against, not a
 * tautology.
 *
 * Every call site must invoke this - one for every gRPC response folded
 * into `input_context` - before any of that data reaches an `LlmClient`
 * call. Accepts the FULL list of facts assembled for one interaction in a
 * single call (Phase 4's multi-module `root_cause_analysis` is the first
 * caller that will actually pass more than one), so a violation is always
 * caught before any of the assembled data - not just the one bad fact -
 * reaches an LLM.
 *
 * Phase 3 (docs/adr/0118): a violation here is now a **durable, queryable**
 * security event, not just an in-process log line and a Prometheus
 * counter. `Logger.error`/`recordTenantScopeAssertionFailure` alone would
 * scroll off stdout and reset on restart - neither is something a real
 * incident-response process can query after the fact ("did tenant X ever
 * receive tenant Y's data") the way Module 01's `GET /v1/audit-log` can.
 * `actor_type: 'system'` (the platform's own control noticing the
 * violation, not a human or an AI-generated action - same reasoning
 * `AuditGrpcClientService`'s own doc comment gives for its Module 08
 * precedent) - `ai_rationale` is not required for this actor type
 * (`audit.proto`'s own rule only applies to `ai_agent`).
 */
@Injectable()
export class TenantScopeAssertionService {
  private readonly logger = new Logger(TenantScopeAssertionService.name);

  constructor(
    private readonly metrics: MetricsService,
    private readonly auditClient: AuditGrpcClientService,
  ) {}

  async assertSameTenant(requestingTenantId: string, facts: TenantScopedFact[]): Promise<void> {
    for (const fact of facts) {
      if (fact.tenantId !== requestingTenantId) {
        this.metrics.recordTenantScopeAssertionFailure(fact.sourceModule);
        this.logger.error(
          `SECURITY: cross-tenant data assembly detected - requesting tenant "${requestingTenantId}" received ` +
            `data scoped to tenant "${fact.tenantId}" from module "${fact.sourceModule}". Request rejected before ` +
            `any LLM call was made.`,
        );
        // Best-effort: AuditGrpcClientService's own contract is "never
        // throws" (it catches its own transport/rejection errors
        // internally), but this rejection is the actual security control -
        // it must fire even if that contract were ever violated by a
        // future change on the audit-client side. Never let an audit-side
        // failure suppress the throw below.
        try {
          await this.auditClient.recordEvent({
            tenantId: requestingTenantId,
            actorId: '',
            actorType: 'system',
            action: 'security.cross_tenant_data_assembly_detected',
            resourceType: 'tenant_scope_assertion',
            resourceId: fact.sourceModule,
            beforeStateJson: '',
            afterStateJson: JSON.stringify({
              requestingTenantId,
              mismatchedTenantId: fact.tenantId,
              sourceModule: fact.sourceModule,
            }),
            aiRationaleJson: '',
          });
        } catch (err) {
          this.logger.warn(
            `Failed to write durable audit record for tenant-scope violation: ${(err as Error).message}`,
          );
        }
        throw new CrossTenantDataAssemblyError(fact.sourceModule);
      }
    }
  }
}
