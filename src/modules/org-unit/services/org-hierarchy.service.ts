import { Injectable } from '@nestjs/common';
import { OrgUnitsRepository } from '../repositories/org-units.repository';
import { OrgUnitHistoryRepository } from '../repositories/org-unit-history.repository';
import { OrgUnitNotFoundError } from '../errors/org-unit-not-found.error';
import { OrgUnitSnapshotType } from '../graphql/org-unit-snapshot.type';
import { OrgUnit } from '../entities/org-unit.entity';
import { OrgUnitHistory } from '../entities/org-unit-history.entity';

interface TreeEdge {
  id: string;
  parentOrgUnitId: string | null;
}

/**
 * Shared by `OrgUnitResolver.orgHierarchy` (GraphQL) and
 * `OrgUnitsController.getTree` (REST `GET /v1/org-units/{id}/tree`) so the
 * as-of/current-state branching logic (ADR-0013) exists in exactly one
 * place, not duplicated per transport.
 */
@Injectable()
export class OrgHierarchyService {
  constructor(
    private readonly orgUnitsRepository: OrgUnitsRepository,
    private readonly orgUnitHistoryRepository: OrgUnitHistoryRepository,
  ) {}

  async getHierarchy(rootId: string, asOf?: Date): Promise<OrgUnitSnapshotType> {
    return asOf ? this.getHierarchyAsOf(rootId, asOf) : this.getCurrentHierarchy(rootId);
  }

  /** Current-state subtree, sourced from the live `path` ltree column (ADR-0008). */
  private async getCurrentHierarchy(rootId: string): Promise<OrgUnitSnapshotType> {
    const rows = await this.orgUnitsRepository.findSubtree(rootId);
    if (rows.length === 0) {
      throw new OrgUnitNotFoundError(rootId);
    }
    const nodesById = new Map(rows.map((r) => [r.id, this.toSnapshot(r)]));
    const edges: TreeEdge[] = rows.map((r) => ({ id: r.id, parentOrgUnitId: r.parentOrgUnitId }));
    return this.assembleTree(rootId, edges, nodesById);
  }

  /**
   * Historical subtree, sourced from `OrgUnitHistory` (ADR-0009), walked in
   * memory via `parentOrgUnitId` rather than a recursive SQL CTE - see
   * `OrgUnitHistoryRepository.findAllAsOf`'s doc comment (ADR-0013).
   */
  private async getHierarchyAsOf(rootId: string, asOf: Date): Promise<OrgUnitSnapshotType> {
    const rootVersion = await this.orgUnitHistoryRepository.findVersionAsOf(rootId, asOf);
    if (!rootVersion) {
      throw new OrgUnitNotFoundError(rootId);
    }
    const allVersions = await this.orgUnitHistoryRepository.findAllAsOf(asOf);
    const nodesById = new Map(allVersions.map((v) => [v.orgUnitId, this.toSnapshotFromHistory(v)]));
    const edges: TreeEdge[] = allVersions.map((v) => ({ id: v.orgUnitId, parentOrgUnitId: v.parentOrgUnitId }));
    return this.assembleTree(rootId, edges, nodesById);
  }

  private assembleTree(
    rootId: string,
    edges: TreeEdge[],
    nodesById: Map<string, OrgUnitSnapshotType>,
  ): OrgUnitSnapshotType {
    const childIdsByParent = new Map<string, string[]>();
    for (const edge of edges) {
      if (edge.parentOrgUnitId) {
        const siblings = childIdsByParent.get(edge.parentOrgUnitId) ?? [];
        siblings.push(edge.id);
        childIdsByParent.set(edge.parentOrgUnitId, siblings);
      }
    }

    const build = (id: string): OrgUnitSnapshotType => {
      const node = nodesById.get(id);
      if (!node) {
        throw new OrgUnitNotFoundError(id);
      }
      node.children = (childIdsByParent.get(id) ?? []).map(build);
      return node;
    };

    return build(rootId);
  }

  private toSnapshot(orgUnit: OrgUnit): OrgUnitSnapshotType {
    const snapshot = new OrgUnitSnapshotType();
    snapshot.id = orgUnit.id;
    snapshot.parentOrgUnitId = orgUnit.parentOrgUnitId;
    snapshot.type = orgUnit.type;
    snapshot.name = orgUnit.name;
    snapshot.timezone = orgUnit.timezone;
    snapshot.countryCode = orgUnit.countryCode;
    snapshot.status = orgUnit.status;
    snapshot.children = [];
    return snapshot;
  }

  private toSnapshotFromHistory(history: OrgUnitHistory): OrgUnitSnapshotType {
    const snapshot = new OrgUnitSnapshotType();
    snapshot.id = history.orgUnitId;
    snapshot.parentOrgUnitId = history.parentOrgUnitId;
    snapshot.type = history.type;
    snapshot.name = history.name;
    snapshot.timezone = history.timezone;
    snapshot.countryCode = history.countryCode;
    snapshot.status = history.status;
    snapshot.children = [];
    return snapshot;
  }
}
