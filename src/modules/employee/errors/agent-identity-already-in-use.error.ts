import { DomainError } from '../../../common/errors/domain-error';

/**
 * Thrown when `addEmployeeDataSource`/`updateEmployeeDataSource` would
 * violate `uq_employee_data_sources_agent_id`/`uq_employee_data_sources_extension`
 * (migration `1700000035000`) - another employee in this tenant already
 * holds that agent id or extension on the same data source. Scoped per data
 * source deliberately: two employees on different ACD systems can
 * legitimately share the same numeric agent id or extension, so uniqueness
 * is only meaningful within one system, not tenant-wide. Previously lived on
 * `org.employees` itself before agentId/extension/dataSource moved to the
 * `EmployeeDataSource` child table - see that entity's own doc comment.
 */
export class AgentIdentityAlreadyInUseError extends DomainError {
  readonly code = 'AGENT_IDENTITY_ALREADY_IN_USE';

  constructor(field: 'agentId' | 'extension', value: string, dataSource: string) {
    super(`${field === 'agentId' ? 'Agent ID' : 'Extension'} "${value}" is already in use for data source "${dataSource}".`, {
      field,
      value,
      dataSource,
    });
  }
}
