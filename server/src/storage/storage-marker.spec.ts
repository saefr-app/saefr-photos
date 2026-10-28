import { describe, expect, it } from 'vitest';
import {
  InvalidStorageMarker,
  locationFingerprint,
  parseStorageMarker,
  roleLocation,
  serializeStorageMarker,
  type StorageMarkerV2,
} from './storage-marker.js';

const location = roleLocation('/srv/media', '/app', 'originals');
const marker: StorageMarkerV2 = {
  version: 2,
  storage_id: '33333333-3333-4333-8333-333333333333',
  binding_id: '44444444-4444-4444-8444-444444444444',
  role: 'originals',
  physical_identity: {
    format: 'linux-ext4-handle-v1',
    profile: 'linux-ext4-v1',
    filesystem_uuid: '55555555-5555-4555-8555-555555555555',
    directory_handle_type: 1,
    directory_handle_hex: '01020304',
    location_sha256: locationFingerprint(location, 'originals'),
  },
};

function changed(change: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ ...marker, ...change }));
}

describe('storage marker v2', () => {
  it('round trips a bounded marker and pins a normalized location', () => {
    const bytes = serializeStorageMarker(marker);
    expect(bytes.length).toBeLessThanOrEqual(1024);
    expect(parseStorageMarker(bytes)).toEqual(marker);
    expect(roleLocation('/srv/./media//', '/app', 'originals')).toBe(location);
    expect(roleLocation('media', '/app', 'originals')).toBe(
      '/app/media/originals',
    );
    expect(locationFingerprint('/srv/other/originals', 'originals')).not.toBe(
      marker.physical_identity.location_sha256,
    );
  });

  it('rejects missing, legacy, conflicting and copied evidence', () => {
    for (const bytes of [
      changed({ version: 1 }),
      changed({ physical_identity: null }),
      changed({ extra: true }),
      Buffer.from(
        JSON.stringify(marker).replace(
          '"role":"originals"',
          '"role":"originals","role":"thumbnails"',
        ),
      ),
      Buffer.from(
        JSON.stringify(marker).replace(
          '"profile":"linux-ext4-v1"',
          '"profile":"linux-ext4-v1","profile":"linux-ext4-v1"',
        ),
      ),
      changed({ storage_id: '00000000-0000-0000-0000-000000000000' }),
      changed({
        storage_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(),
      }),
    ])
      expect(() => parseStorageMarker(bytes)).toThrow(InvalidStorageMarker);
  });

  it('rejects oversized, malformed and unsupported physical evidence', () => {
    for (const bytes of [
      Buffer.alloc(1025, 32),
      Buffer.from([0xff]),
      Buffer.from(`\ufeff${JSON.stringify(marker)}`),
      changed({
        physical_identity: {
          ...marker.physical_identity,
          directory_handle_hex: 'AABB',
        },
      }),
      changed({
        physical_identity: {
          ...marker.physical_identity,
          directory_handle_hex: 'f'.repeat(258),
        },
      }),
      changed({
        physical_identity: { ...marker.physical_identity, profile: 'other' },
      }),
      changed({
        physical_identity: {
          ...marker.physical_identity,
          directory_handle_type: 2147483648,
        },
      }),
    ])
      expect(() => parseStorageMarker(bytes)).toThrow(InvalidStorageMarker);
  });

  it('rejects unsafe location inputs', () => {
    expect(() => roleLocation('/srv/\0media', '/app', 'originals')).toThrow(
      InvalidStorageMarker,
    );
    expect(() => roleLocation('/srv/media', 'relative', 'originals')).toThrow(
      InvalidStorageMarker,
    );
    expect(() => locationFingerprint('relative', 'originals')).toThrow(
      InvalidStorageMarker,
    );
  });
});
