import { ConnectorType } from './entities/integration-connector.entity';

/**
 * §0/§1/ADR-0135: the batch/streaming split is this module's second
 * central non-negotiable - but the spec's own §2.2 rule 3a/3b only
 * classifies `hris|payroll|crm` as batch and `acd` as streaming.
 * `custom_webhook` (the fifth `connector_type` value, §2.1) is never
 * assigned to either shape anywhere in the module prompt. Rather than
 * silently guessing which write-path discipline it should inherit, it is
 * deliberately excluded from both sets here - `isBatchConnectorType`/
 * `isStreamingConnectorType` both return `false` for it, and every caller
 * of these two functions treats "neither" as its own explicit, disclosed
 * gap (a clear error, not a silent default) rather than an omission. See
 * the Phase 2 design doc's explicit-assumptions section.
 */
const BATCH_CONNECTOR_TYPES: ReadonlySet<ConnectorType> = new Set([
  ConnectorType.HRIS,
  ConnectorType.PAYROLL,
  ConnectorType.CRM,
]);

export function isBatchConnectorType(connectorType: ConnectorType): boolean {
  return BATCH_CONNECTOR_TYPES.has(connectorType);
}

export function isStreamingConnectorType(connectorType: ConnectorType): boolean {
  return connectorType === ConnectorType.ACD;
}
