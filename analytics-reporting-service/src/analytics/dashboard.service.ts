import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { randomUUID } from 'crypto';
import { withTenantConnection } from '../database/with-tenant-connection';
import { SavedReport, SavedReportType } from './entities/saved-report.entity';
import { DashboardWidget } from './entities/dashboard-widget.entity';
import { MetricDefinition, MetricCostTier } from './entities/metric-definition.entity';
import { DashboardNotFoundError } from './errors/dashboard-not-found.error';
import { MetricNotFoundError } from './errors/metric-not-found.error';
import { ExpensiveMetricNotAllowedOnWidgetError } from './errors/expensive-metric-not-allowed-on-widget.error';
import { UnvalidatedMetricNotAllowedOnWidgetError } from './errors/metric-validation-failed.error';

export interface CreateDashboardWidgetInput {
  widgetType: string;
  metricId: string;
  position: Record<string, unknown>;
}

export interface CreateDashboardInput {
  name: string;
  config: Record<string, unknown>;
  widgets: CreateDashboardWidgetInput[];
  /** Role *names* (core's own JWT `roles` claim shape - see access-token.guard.ts) this dashboard is shared with. Optional, defaults to none shared. */
  sharedWithRoles?: string[];
}

export interface DashboardWithWidgets {
  dashboard: SavedReport;
  widgets: DashboardWidget[];
}

/**
 * Phase 4 (§4.1's `createDashboard`/`dashboard`/`myDashboards`). Every
 * method goes through `withTenantConnection` (`with-tenant-connection.ts`)
 * - the platform's established RLS-scoping convention for TypeORM-based
 * request-scoped CRUD (own copy per service, ADR-0039).
 *
 * ADR-0163 closes §2.3 rule 3's `sharedWith` gap: `getDashboard`/
 * `listMyDashboards` now also grant access when the caller's *currently
 * held* roles (`AccessTokenClaims.roles`, read from a freshly verified JWT
 * - never a locally cached or stale copy) intersect the dashboard's
 * `sharedWith` list. Sharing is by role name, not by individually-listed
 * user id - the JWT's own `roles` claim is exactly "the set of roles this
 * caller holds as of this token's issuance" (a ≤720s-old fact, the same
 * staleness bound every other RBAC check in this platform already accepts),
 * so a user's access to a shared dashboard changes the moment their role
 * assignment does, with nothing on the dashboard row itself needing to
 * change - the concrete meaning of "resolved against live Module 01
 * RBAC... not a snapshot from when it was created."
 *
 * Only the owner may edit (`updateDashboard`) or delete - sharing here
 * grants view access, not co-ownership; §2.3 rule 3 never asked for
 * shared-editor semantics and this module has no per-share permission
 * level to store one in anyway.
 */
@Injectable()
export class DashboardService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async createDashboard(tenantId: string, actorId: string, input: CreateDashboardInput): Promise<DashboardWithWidgets> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      for (const widget of input.widgets) {
        await this.assertWidgetMetricUsable(manager, tenantId, widget.metricId);
      }

      const id = randomUUID();
      await manager.insert(SavedReport, {
        id,
        tenantId,
        createdBy: actorId,
        name: input.name,
        reportType: SavedReportType.DASHBOARD,
        config: asJsonbValue(input.config),
        scheduleCron: null,
        sharedWith: input.sharedWithRoles ?? [],
      });

      const widgets: DashboardWidget[] = [];
      for (const widget of input.widgets) {
        const widgetId = randomUUID();
        await manager.insert(DashboardWidget, {
          id: widgetId,
          tenantId,
          dashboardId: id,
          widgetType: widget.widgetType,
          metricId: widget.metricId,
          position: asJsonbValue(widget.position),
        });
        widgets.push(await manager.findOneByOrFail(DashboardWidget, { id: widgetId }));
      }

      const dashboard = await manager.findOneByOrFail(SavedReport, { id });
      return { dashboard, widgets };
    });
  }

  async getDashboard(
    tenantId: string,
    actorId: string,
    actorRoles: string[],
    id: string,
  ): Promise<DashboardWithWidgets> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const dashboard = await manager.findOne(SavedReport, {
        where: { id, reportType: SavedReportType.DASHBOARD },
      });
      if (!dashboard || !this.isVisibleTo(dashboard, actorId, actorRoles)) {
        throw new DashboardNotFoundError(id);
      }
      const widgets = await manager.find(DashboardWidget, { where: { dashboardId: id } });
      return { dashboard, widgets };
    });
  }

  /**
   * §1's `/analytics/dashboards/[id]/edit` builder needs a real write path
   * for an *existing* dashboard - §4.1 named only `createDashboard`, but a
   * builder that can create and never edit isn't the builder the page
   * inventory describes. Full-replace semantics for widgets (delete every
   * existing row, insert the input's list fresh) rather than a diff/patch -
   * the same "whole collection replace" shape `CreateDashboardInputType`
   * already uses for create, so the builder's own save action doesn't need
   * two different request shapes depending on whether it's creating or
   * editing. Owner-only (`createdBy === actorId`) - see this class's own
   * doc comment on why sharing grants view access, not co-ownership; a
   * shared user's `sharedWithRoles` intersection never satisfies this
   * check.
   */
  async updateDashboard(
    tenantId: string,
    actorId: string,
    id: string,
    input: CreateDashboardInput,
  ): Promise<DashboardWithWidgets> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const existing = await manager.findOne(SavedReport, {
        where: { id, reportType: SavedReportType.DASHBOARD },
      });
      if (!existing || existing.createdBy !== actorId) {
        throw new DashboardNotFoundError(id);
      }

      for (const widget of input.widgets) {
        await this.assertWidgetMetricUsable(manager, tenantId, widget.metricId);
      }

      await manager.update(
        SavedReport,
        { id },
        {
          name: input.name,
          config: asJsonbValue(input.config),
          sharedWith: asJsonbValue(input.sharedWithRoles ?? (existing.sharedWith as unknown as string[])),
          updatedAt: new Date(),
        },
      );

      await manager.delete(DashboardWidget, { dashboardId: id });
      const widgets: DashboardWidget[] = [];
      for (const widget of input.widgets) {
        const widgetId = randomUUID();
        await manager.insert(DashboardWidget, {
          id: widgetId,
          tenantId,
          dashboardId: id,
          widgetType: widget.widgetType,
          metricId: widget.metricId,
          position: asJsonbValue(widget.position),
        });
        widgets.push(await manager.findOneByOrFail(DashboardWidget, { id: widgetId }));
      }

      const dashboard = await manager.findOneByOrFail(SavedReport, { id });
      return { dashboard, widgets };
    });
  }

  /**
   * "My Dashboards" now means "visible to me" - owned, plus anything
   * shared with a role the caller currently holds - not literally
   * `createdBy = actorId` only, matching `getDashboard`'s own widened
   * check. Filtered in application code, not a `sharedWith ?| array[...]`
   * jsonb-containment WHERE clause - one query for the whole tenant's
   * dashboard rows either way, and this keeps the visibility rule in one
   * place (`isVisibleTo`) instead of a second, SQL-shaped copy of it.
   */
  async listMyDashboards(tenantId: string, actorId: string, actorRoles: string[]): Promise<DashboardWithWidgets[]> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const allDashboards = await manager.find(SavedReport, {
        where: { reportType: SavedReportType.DASHBOARD },
        order: { createdAt: 'DESC' },
      });
      const dashboards = allDashboards.filter((d) => this.isVisibleTo(d, actorId, actorRoles));
      // One query per dashboard, not a single batched IN(...) - acceptable
      // for a "my dashboards" list at this phase's expected scale; revisit
      // if a real tenant's dashboard count makes this a real N+1 problem.
      const results: DashboardWithWidgets[] = [];
      for (const dashboard of dashboards) {
        const widgets = await manager.find(DashboardWidget, { where: { dashboardId: dashboard.id } });
        results.push({ dashboard, widgets });
      }
      return results;
    });
  }

  private isVisibleTo(dashboard: SavedReport, actorId: string, actorRoles: string[]): boolean {
    if (dashboard.createdBy === actorId) {
      return true;
    }
    const sharedWithRoles = dashboard.sharedWith as unknown as string[];
    return sharedWithRoles.some((role) => actorRoles.includes(role));
  }

  private async assertWidgetMetricUsable(manager: EntityManager, tenantId: string, metricId: string): Promise<void> {
    const metric =
      (await manager.findOne(MetricDefinition, { where: { id: metricId, tenantId } })) ??
      (await manager.findOne(MetricDefinition, { where: { id: metricId, tenantId: IsNull() } }));
    if (!metric) {
      throw new MetricNotFoundError(metricId);
    }
    // §2.3 rule 2/ADR-0110: an unvalidated metric cannot back a live
    // widget any more than an expensive one can - Phase 4's guard only
    // checked cost tier, since nothing before Phase 5 could ever produce
    // an unvalidated row.
    if (!metric.validatedAt) {
      throw new UnvalidatedMetricNotAllowedOnWidgetError(metric.name);
    }
    if (metric.estimatedCostTier === MetricCostTier.EXPENSIVE) {
      throw new ExpensiveMetricNotAllowedOnWidgetError(metric.name);
    }
  }
}

// Own copy of adherence-compliance-service's `asJsonbValue` (ADR-0039
// precedent) - TypeORM's `insert()`/`update()` `QueryDeepPartialEntity`
// type doesn't accept a plain object or array for a jsonb column directly;
// this is the same one-line cast that service's own compliance-rule.service.ts
// uses for `ComplianceRule.definition`. Widened to `unknown` (rather than
// `Record<string, unknown>`) so it also covers `SavedReport.sharedWith`'s
// jsonb array, not just object-shaped jsonb columns.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asJsonbValue(value: unknown): any {
  return value;
}
