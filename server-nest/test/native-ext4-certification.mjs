import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
if (process.argv[2] === '--crash-after-link') {
  const root = process.env.SAEFR_NATIVE_FIRST;
  const assetId = process.env.SAEFR_NATIVE_CRASH_ASSET;
  assert.ok(root && assetId);
  const originalMarker = parseStorageMarker(
    await readFile(join(root, 'originals', '.saefr-storage.json')),
  );
  const thumbnailMarker = parseStorageMarker(
    await readFile(join(root, 'thumbnails', '.saefr-storage.json')),
  );
  const config = new ConfigService({
    STORAGE_ROOT: root,
    STORAGE_ID: originalMarker.storage_id,
    STORAGE_ORIGINALS_BINDING_ID: originalMarker.binding_id,
    STORAGE_THUMBNAILS_BINDING_ID: thumbnailMarker.binding_id,
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
              storage_id: originalMarker.storage_id,
              originals_binding_id: originalMarker.binding_id,
              thumbnails_binding_id: thumbnailMarker.binding_id,
              storage_layout_version: 1,
            }),
          }),
        }),
      }),
    },
  };
  class PausingProvider extends LocalStorageProvider {
    async syncDirectory() {
      process.stdout.write('LINKED\n');
      await new Promise(() => setInterval(() => undefined, 1_000));
    }
  }
  const provider = new PausingProvider(
    new StorageBindingVerifier(database, config, observer),
    config,
  );
  await provider.publish(
    { role: 'originals', assetId, extension: '.jpg' },
    randomUUID(),
    Readable.from([Buffer.from('synthetic crash fixture')]),
  );
  throw new Error('Expected parent to terminate the paused publication');
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

// Kill a real process after link creation but before directory-sync
// acknowledgement. The surviving target is uncertain, not evidence of a
// completed durable upload. Only this disposable fixture is then removed.
const crashAsset = randomUUID();
const child = spawn(process.execPath, [process.argv[1], '--crash-after-link'], {
  env: {
    ...process.env,
    SAEFR_NATIVE_CRASH_ASSET: crashAsset,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const childClosed = new Promise((resolve) =>
  child.once('close', (code, signal) => resolve({ code, signal })),
);
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Crash probe timed out')),
      10_000,
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('LINKED\n')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Crash probe exited before link: ${code}`));
    });
  });
} finally {
  child.kill('SIGKILL');
}
const killed = await childClosed;
assert.equal(killed.signal, 'SIGKILL');
const crashTarget = join(originals, `${crashAsset}.jpg`);
assert.deepEqual(
  await readFile(crashTarget),
  Buffer.from('synthetic crash fixture'),
);
const stageFiles = (await readdir(originals)).filter(
  (name) => name.startsWith(`.${crashAsset}.`) && name.endsWith('.uploading'),
);
assert.equal(stageFiles.length, 1);
await rm(crashTarget);
await rm(join(originals, stageFiles[0]));
console.log(
  'Process-kill after link retained possible media for explicit reconciliation',
);
