/**
 * Hard-enforcement geofencing rejection (docs/adr/0155) - the tenant's
 * configured `geofence_boundary` Policy has `enforcement: 'hard'` and the
 * captured (or absent - ADR-0155's decline-is-unverified rule) location is
 * outside the boundary. Mapped to `conflict`, not `failed`
 * (docs/adr/0153's rule): this exact location will never succeed
 * unmodified, a true conflict. Thrown and caught entirely inside
 * `MobileSyncService.processClockEvent` - attendance-leave-service never
 * receives the request at all for this outcome.
 */
export class ClockEventGeofenceViolationError extends Error {
  constructor() {
    super('Clock event location is outside the configured geofence boundary (hard enforcement).');
    this.name = 'ClockEventGeofenceViolationError';
  }
}
