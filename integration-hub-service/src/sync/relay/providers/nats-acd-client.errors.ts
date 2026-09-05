import { DomainError } from '../../../common/errors/domain-error';

/** Connection, auth, or JetStream-provisioning failure against a customer's own on-prem NATS server - see `NatsAcdAdapter`'s own doc comment for what "on-prem" changes about this adapter's shape versus every cloud-vendor one in this directory. */
export class NatsAcdConnectionError extends DomainError {
  constructor(cause: string) {
    super('NATS_ACD_CONNECTION_ERROR', `On-prem NATS ACD connection failed: ${cause}`);
  }
}
