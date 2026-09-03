import { DomainError } from './domain-error';

export class UpstreamUnavailableError extends DomainError {
  constructor(
    public readonly upstream: string,
    cause?: unknown,
  ) {
    super('UPSTREAM_UNAVAILABLE', `Upstream "${upstream}" is unavailable${cause ? `: ${String(cause)}` : ''}`);
  }
}
