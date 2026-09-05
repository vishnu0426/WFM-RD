import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * "Associated Integration Service Installations" - which registered
 * `IntegrationServer` rows a given connector (data source) is documented
 * against. Many-to-many: a single server can be shared across multiple
 * data sources, matching the real product's own model (see
 * `IntegrationServer`'s own doc comment for sources).
 */
@Entity({ name: 'integration_connector_server', schema: 'integration_hub' })
export class IntegrationConnectorServer {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'connector_id' })
  connectorId!: string;

  @Column('uuid', { name: 'server_id' })
  serverId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
