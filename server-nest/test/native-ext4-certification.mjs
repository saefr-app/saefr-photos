import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LinuxPhysicalStorageObserver } from '../dist/storage/linux-physical-storage.observer.js';
import {
  locationFingerprint,
  parseStorageMarker,
  serializeStorageMarker,
} from '../dist/storage/storage-marker.js';

const observer = new LinuxPhysicalStorageObserver();
if (process.argv[2] === '--missing') {
  await assert.rejects(
    observer.observeIdentity('originals', process.env.SAEFR_NATIVE_MISSING),
  );
  console.log('Missing mount: rejected');
  process.exit(0);
}

const first = process.env.SAEFR_NATIVE_FIRST;
const second = process.env.SAEFR_NATIVE_SECOND;
assert.ok(first && second);
const originals = join(first, 'originals');
const thumbnails = join(first, 'thumbnails');
const replacement = join(second, 'originals');
const originalIdentity = await observer.observeIdentity('originals', originals);
const reopened = await observer.observeIdentity('originals', originals);
const thumbnailIdentity = await observer.observeIdentity(
  'thumbnails',
  thumbnails,
);
const replacementIdentity = await observer.observeIdentity(
  'originals',
  replacement,
);
assert.deepEqual(originalIdentity, reopened);
assert.equal(
  originalIdentity.filesystem_uuid,
  thumbnailIdentity.filesystem_uuid,
);
assert.notEqual(
  originalIdentity.directory_handle_hex,
  thumbnailIdentity.directory_handle_hex,
);
assert.notEqual(
  originalIdentity.filesystem_uuid,
  replacementIdentity.filesystem_uuid,
);

const marker = serializeStorageMarker({
  version: 2,
  storage_id: randomUUID(),
  binding_id: randomUUID(),
  role: 'originals',
  physical_identity: {
    ...originalIdentity,
    location_sha256: locationFingerprint(originals, 'originals'),
  },
});
await writeFile(join(originals, '.saefr-storage.json'), marker, {
  flag: 'wx',
  mode: 0o600,
});
assert.deepEqual(
  (await observer.observe('originals', originals)).markerBytes,
  marker,
);
await copyFile(
  join(originals, '.saefr-storage.json'),
  join(replacement, '.saefr-storage.json'),
);
const copied = await observer.observe('originals', replacement);
const copiedMarker = parseStorageMarker(copied.markerBytes);
assert.notEqual(
  copied.identity.filesystem_uuid,
  copiedMarker.physical_identity.filesystem_uuid,
);
assert.notEqual(
  copiedMarker.physical_identity.location_sha256,
  locationFingerprint(replacement, 'originals'),
);
await assert.rejects(
  observer.observeIdentity('originals', process.env.SAEFR_NATIVE_UNSUPPORTED),
);
console.log(
  'Native ext4: stable reopen, separate roles, independent filesystem, copied marker and unsupported filesystem checks passed',
);
