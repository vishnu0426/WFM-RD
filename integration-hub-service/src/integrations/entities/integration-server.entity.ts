import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export enum IntegrationServerRole {
  RECORDER_INTEGRATION_SERVICE = 'recorder_integration_service',
  IP_RECORDER = 'ip_recorder',
  TDM_RECORDER = 'tdm_recorder',
  SCREEN_RECORDER = 'screen_recorder',
  RECORDER_ADAPTER_PROXY_SERVICE = 'recorder_adapter_proxy_service',
  CONTENT_SERVER = 'content_server',
  IP_ANALYZER = 'ip_analyzer',
  CENTRAL_ARCHIVE = 'central_archive',
}

/**
 * Integration Servers - a real, persisted inventory of a tenant's own
 * on-prem recording infrastructure. Fields and role names are grounded in
 * Verint WFO/EMT's real, documented "Server" and "Recorder Integration
 * Service" admin screens (the product this platform's own "Integration
 * Servers"/"Recorder"/"Device IP Configuration"/"SIP Call Tracking"
 * terminology was modeled on) - confirmed live during implementation:
 * https://wfo.mon2.verintcloudservices.com/onlinehelp/en_us/emt/rec_EM_EM_Config_Admin_Guide/rec_EM_Create_a_Server__Windows_domain_.htm
 * (serverName/portNumber/httpsPortNumber/httpAlias/blocked)
 * https://wfo.f2.verintcloudservices.com/OnlineHelp_en/emt/Recorder_config/rec_RecCfg_Roles.htm
 * (the eight real role names in `IntegrationServerRole`)
 *
 * This is deliberately a registry, not a control plane - see this
 * migration's own doc comment for why. Nothing on this platform opens an
 * RMI/TDM/SIP connection to a row here; it exists so a tenant can document
 * their own real deployment topology in one place.
 */
@Entity({ name: 'integration_server', schema: 'integration_hub' })
export class IntegrationServer {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { length: 200 })
  name!: string;

  @Column('varchar', { length: 2000, nullable: true })
  description!: string | null;

  /** Host name, FQDN, or IP address - Verint's own "Server Name" field. */
  @Column('varchar', { name: 'server_name', length: 255 })
  serverName!: string;

  @Column('integer', { name: 'port_number', nullable: true })
  portNumber!: number | null;

  @Column('integer', { name: 'https_port_number', nullable: true })
  httpsPortNumber!: number | null;

  /** Load-balancer address for a clustered deployment - Verint's own "HTTP Alias" field. */
  @Column('varchar', { name: 'http_alias', length: 255, nullable: true })
  httpAlias!: string | null;

  /** "Blocked" in the real product: prevents the server from receiving configuration messages. Here: a documentation flag only (see class doc comment - this platform never sends it anything). */
  @Column('boolean', { default: false })
  blocked!: boolean;

  @Column('varchar', { array: true, length: 50 })
  roles!: IntegrationServerRole[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
