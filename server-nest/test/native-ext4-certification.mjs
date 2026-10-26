import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';

import { BoundImageStorageService } from '../dist/storage/bound-image-storage.service.js';
import { LinuxPhysicalStorageObserver } from '../dist/storage/linux-physical-storage.observer.js';
import { LocalStorageProvider } from '../dist/storage/local-storage.provider.js';
import { StorageBindingVerifier } from '../dist/storage/storage-binding.service.js';
import {
  locationFingerprint,
  parseStorageMarker,
  serializeStorageMarker,
} from '../dist/storage/storage-marker.js';

const observer = new LinuxPhysicalStorageObserver();
if (process.argv[2] === '--identity') {
  const observed = await observer.observe(
    'originals',
    process.env.SAEFR_NATIVE_ROLE,
  );
  console.log(JSON.stringify(observed.identity));
  process.exit(0);
}
if (process.argv[2] === '--swapped') {
  const observed = await observer.observe(
    'thumbnails',
    process.env.SAEFR_NATIVE_SWAPPED,
  );
  const marker = parseStorageMarker(observed.markerBytes);
  assert.notEqual(marker.role, 'thumbnails');
  assert.notEqual(
    marker.physical_identity.location_sha256,
    locationFingerprint(process.env.SAEFR_NATIVE_SWAPPED, 'thumbnails'),
  );
  console.log('Swapped role mount: marker and location mismatch detected');
  process.exit(0);
}
if (process.argv[2] === '--missing') {
  const observed = await observer.observe(
    'originals',
    process.env.SAEFR_NATIVE_MISSING,
  );
  const marker = parseStorageMarker(observed.markerBytes);
  assert.notEqual(
    marker.physical_identity.location_sha256,
    locationFingerprint(process.env.SAEFR_NATIVE_MISSING, 'originals'),
  );
  console.log(
    'Missing mount exposing copied marker: physical/location mismatch detected',
  );
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

const ids = {
  storage: randomUUID(),
  originals: randomUUID(),
  thumbnails: randomUUID(),
};
function roleMarker(role, identity, location) {
  return serializeStorageMarker({
    version: 2,
    storage_id: ids.storage,
    binding_id: ids[role],
    role,
    physical_identity: {
      ...identity,
      location_sha256: locationFingerprint(location, role),
    },
  });
}
const marker = roleMarker('originals', originalIdentity, originals);
await writeFile(join(originals, '.saefr-storage.json'), marker, {
  flag: 'wx',
  mode: 0o600,
});
await writeFile(
  join(thumbnails, '.saefr-storage.json'),
  roleMarker('thumbnails', thumbnailIdentity, thumbnails),
  { flag: 'wx', mode: 0o600 },
);
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

const config = new ConfigService({
  STORAGE_ROOT: first,
  STORAGE_ID: ids.storage,
  STORAGE_ORIGINALS_BINDING_ID: ids.originals,
  STORAGE_THUMBNAILS_BINDING_ID: ids.thumbnails,
  STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
  STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
});
const database = {
  db: {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          executeTakeFirst: async () => ({
            singleton: true,
            storage_id: ids.storage,
            originals_binding_id: ids.originals,
            thumbnails_binding_id: ids.thumbnails,
            storage_layout_version: 1,
          }),
        }),
      }),
    }),
  },
};
const provider = new LocalStorageProvider(
  new StorageBindingVerifier(database, config, observer),
  config,
);
const images = new BoundImageStorageService(provider, config);
const assetId = randomUUID();
const originalBytes = await sharp({
  create: {
    width: 3,
    height: 3,
    channels: 3,
    background: '#337799',
  },
})
  .jpeg()
  .toBuffer();
const saved = await images.saveImage(
  assetId,
  'image/jpeg',
  Readable.from([originalBytes]),
);
const openedOriginal = await images.openOriginal(
  assetId,
  'image/jpeg',
  saved.storagePath,
);
const originalChunks = [];
for await (const chunk of openedOriginal.stream) originalChunks.push(chunk);
assert.deepEqual(Buffer.concat(originalChunks), originalBytes);
const openedThumbnail = await images.openThumbnail(assetId);
const thumbnailChunks = [];
for await (const chunk of openedThumbnail.stream) thumbnailChunks.push(chunk);
assert.ok(Buffer.concat(thumbnailChunks).length > 0);
await images.finalizeImage(assetId);
assert.deepEqual(
  await provider.removeExact({ role: 'originals', assetId, extension: '.jpg' }),
  { status: 'removed', durable: true },
);
assert.deepEqual(
  await provider.removeExact({
    role: 'thumbnails',
    assetId,
    extension: '.jpg',
  }),
  { status: 'removed', durable: true },
);
console.log(
  'Native ext4: identity, marker, exact-byte upload, media reads and provider removal checks passed',
);
