import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Tenant Admin Integration Management, WP3 (plan decision #4). Join table:
 * one `DataSourceGroup` to many `forecasting-service.CcQueue` rows. `ccQueueId`
 * is a bare uuid, not a real foreign key - `CcQueue` lives in a different
 * service's own Postgres schema/role (`forecasting`), the same
 * cross-service-reference-by-bare-id convention this platform already uses
 * elsewhere (e.g. `WorkRule.assigneeId`). Referential integrity against a
 * real `CcQueue` row is enforced at the application layer
 * (`DataSourceGroupsService`, which resolves the id via forecasting-service's
 * own `GET /v1/forecasting/cc-queues/{id}` before saving a membership row).
 */
@Entity({ name: 'data_source_group_queue', schema: 'integration_hub' })
export class DataSourceGroupQueue {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'group_id' })
  groupId!: string;

  @Column('uuid', { name: 'cc_queue_id' })
  ccQueueId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
