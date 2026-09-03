import { DataSource, EntityManager } from 'typeorm';
import { MarketplacePostQueryService } from '../../../src/marketplace/marketplace-post-query.service';
import {
  MarketplacePost,
  MarketplacePostStatus,
  MarketplacePostType,
} from '../../../src/marketplace/entities/marketplace-post.entity';

const TENANT_ID = 'tenant-1';
const ORG_UNIT_ID = 'org-1';

describe('MarketplacePostQueryService.listByOrgUnit (Shift Marketplace Manager View phase, §3)', () => {
  let queryBuilder: { where: jest.Mock; andWhere: jest.Mock; orderBy: jest.Mock; getMany: jest.Mock };
  let manager: jest.Mocked<Pick<EntityManager, 'createQueryBuilder' | 'query'>>;
  let dataSource: Pick<DataSource, 'transaction'>;
  let service: MarketplacePostQueryService;

  beforeEach(() => {
    queryBuilder = { where: jest.fn(), andWhere: jest.fn(), orderBy: jest.fn(), getMany: jest.fn() };
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.andWhere.mockReturnValue(queryBuilder);
    queryBuilder.orderBy.mockReturnValue(queryBuilder);

    manager = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    service = new MarketplacePostQueryService(dataSource as DataSource);
  });

  it('filters by tenant and orgUnitId, ordered by expiresAt ascending, with no status filter by default', async () => {
    queryBuilder.getMany.mockResolvedValue([]);

    await service.listByOrgUnit(TENANT_ID, ORG_UNIT_ID);

    expect(queryBuilder.where).toHaveBeenCalledWith('post.tenantId = :tenantId', { tenantId: TENANT_ID });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('post.orgUnitId = :orgUnitId', { orgUnitId: ORG_UNIT_ID });
    expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('post.status = :status', expect.anything());
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('post.expiresAt', 'ASC');
  });

  it('adds a status filter only when one is provided', async () => {
    queryBuilder.getMany.mockResolvedValue([]);

    await service.listByOrgUnit(TENANT_ID, ORG_UNIT_ID, MarketplacePostStatus.CLAIMED);

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('post.status = :status', {
      status: MarketplacePostStatus.CLAIMED,
    });
  });

  it('returns the rows the query produces', async () => {
    const rows: MarketplacePost[] = [
      {
        id: 'post-1',
        tenantId: TENANT_ID,
        postType: MarketplacePostType.OPEN_SHIFT,
        shiftAssignmentId: 'shift-1',
        orgUnitId: ORG_UNIT_ID,
        postedBy: null,
        status: MarketplacePostStatus.OPEN,
        eligibilityRules: {},
        expiresAt: new Date(),
        createdAt: new Date(),
      },
    ];
    queryBuilder.getMany.mockResolvedValue(rows);

    const result = await service.listByOrgUnit(TENANT_ID, ORG_UNIT_ID);

    expect(result).toEqual(rows);
  });
});
