import { haversineDistanceMeters } from '../../src/geofence/haversine-distance';

describe('haversineDistanceMeters', () => {
  it('returns 0 for identical coordinates', () => {
    const point = { latitude: 37.7749, longitude: -122.4194 };
    expect(haversineDistanceMeters(point, point)).toBe(0);
  });

  it('returns a known real-world distance within a small tolerance', () => {
    // San Francisco City Hall -> Oakland City Hall, ~13.4km great-circle.
    const sf = { latitude: 37.7793, longitude: -122.4193 };
    const oakland = { latitude: 37.8044, longitude: -122.2712 };

    const distance = haversineDistanceMeters(sf, oakland);

    expect(distance).toBeGreaterThan(13000);
    expect(distance).toBeLessThan(13800);
  });

  it('is symmetric', () => {
    const a = { latitude: 40.7128, longitude: -74.006 };
    const b = { latitude: 34.0522, longitude: -118.2437 };

    expect(haversineDistanceMeters(a, b)).toBeCloseTo(haversineDistanceMeters(b, a), 6);
  });

  it('a small offset stays within a small-radius geofence', () => {
    const center = { latitude: 37.7749, longitude: -122.4194 };
    // ~10 meters north.
    const nearby = { latitude: 37.77499, longitude: -122.4194 };

    expect(haversineDistanceMeters(center, nearby)).toBeLessThan(15);
  });
});
