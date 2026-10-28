import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';

import { DatabaseService } from '../database/database.service.js';
import { readProtectedOperatorRecord } from './storage-adoption-inventory.js';
import { roleLocation, type StorageRole } from './storage-marker.js';

const DIGEST = /^[0-9a-f]{64}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TARGET = new RegExp(`^${UUID}\\.(?:jpg|png|webp)$`);
const STAGE = new RegExp(`^\\.${UUID}\\.${UUID}\\.${UUID}\\.uploading$`);
const EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export interface ControlledRecoveryEvidence {
  readonly version: 1;
  readonly databaseName: string;
  readonly storageRoot: string;
  readonly backupRecordSha256: string;
  readonly binding: {
    readonly storageId: string;
    readonly originalsBindingId: string;
    readonly thumbnailsBindingId: string;
  };
  readonly assetRowsSha256: string;
  readonly deletionRowsSha256: string;
  readonly files: readonly {
    readonly role: StorageRole;
    readonly name: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}

function unavailable(): Error {
  return new Error('Storage recovery evidence unavailable');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function assertControlledRecoveryDatabase(
  database: DatabaseService,
  evidence: ControlledRecoveryEvidence,
): Promise<void> {
  const binding = await database.db
    .selectFrom('storage_binding')
    .selectAll()
    .where('singleton', '=', true)
    .executeTakeFirst();
  if (
    !binding ||
    binding.storage_layout_version !== 1 ||
    binding.storage_id !== evidence.binding.storageId ||
    binding.originals_binding_id !== evidence.binding.originalsBindingId ||
    binding.thumbnails_binding_id !== evidence.binding.thumbnailsBindingId ||
    digest(
      await database.db.selectFrom('asset').selectAll().orderBy('id').execute(),
    ) !== evidence.assetRowsSha256 ||
    digest(
      await database.db
        .selectFrom('asset_deletion')
        .selectAll()
        .orderBy('asset_id')
        .execute(),
    ) !== evidence.deletionRowsSha256
  )
    throw unavailable();
}

async function pin(location: string): Promise<FileHandle> {
  let cursor = '/';
  for (const part of location.split('/').filter(Boolean)) {
    cursor = posix.join(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
  }
  return open(
    location,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
}

async function fileEvidence(
  directory: FileHandle,
  role: StorageRole,
  name: string,
) {
  if (!TARGET.test(name) && !STAGE.test(name)) throw unavailable();
  const file = await open(
    `/proc/self/fd/${directory.fd}/${name}`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1) throw unavailable();
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hash.update(chunk);
    const after = await file.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw unavailable();
    return { role, name, size: before.size, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}

/**
 * Read-only stopped-service recovery gate. The evidence must be independently
 * reviewed against the backup and complete database/media pair. This does not
 * authorize cutover or establish that every writer has actually stopped.
 */
export async function assertControlledRecoveryInventory(
  database: DatabaseService,
  root: string,
  databaseName: string,
  evidencePath: string,
  expectedBackupRecordSha256: string,
): Promise<ControlledRecoveryEvidence> {
  try {
    const bytes = await readProtectedOperatorRecord(evidencePath, root);
    const evidence = JSON.parse(
      bytes.toString('utf8'),
    ) as ControlledRecoveryEvidence;
    if (
      !evidence ||
      Object.keys(evidence).sort().join(',') !==
        'assetRowsSha256,backupRecordSha256,binding,databaseName,deletionRowsSha256,files,storageRoot,version' ||
      evidence.version !== 1 ||
      evidence.databaseName !== databaseName ||
      evidence.storageRoot !== posix.resolve(root) ||
      !DIGEST.test(expectedBackupRecordSha256) ||
      evidence.backupRecordSha256 !== expectedBackupRecordSha256 ||
      !DIGEST.test(evidence.assetRowsSha256) ||
      !DIGEST.test(evidence.deletionRowsSha256) ||
      !Array.isArray(evidence.files) ||
      !evidence.binding
    )
      throw unavailable();
    await assertControlledRecoveryDatabase(database, evidence);
    const rows = await database.db
      .selectFrom('asset')
      .selectAll()
      .orderBy('id')
      .execute();
    const deletions = await database.db
      .selectFrom('asset_deletion')
      .selectAll()
      .orderBy('asset_id')
      .execute();
    if (
      digest(rows) !== evidence.assetRowsSha256 ||
      digest(deletions) !== evidence.deletionRowsSha256
    )
      throw unavailable();
    const actual = [];
    for (const role of ['originals', 'thumbnails'] as const) {
      const location = roleLocation(root, process.cwd(), role);
      const directory = await pin(location);
      try {
        const names = (await readdir(`/proc/self/fd/${directory.fd}`)).sort();
        if (names.includes('.saefr-storage.json')) throw unavailable();
        for (const name of names)
          actual.push(await fileEvidence(directory, role, name));
        const current = await lstat(location);
        const opened = await directory.stat();
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino
        )
          throw unavailable();
      } finally {
        await directory.close();
      }
    }
    const files = [...evidence.files].sort((a, b) =>
      `${a.role}/${a.name}`.localeCompare(`${b.role}/${b.name}`),
    );
    actual.sort((a, b) =>
      `${a.role}/${a.name}`.localeCompare(`${b.role}/${b.name}`),
    );
    if (JSON.stringify(files) !== JSON.stringify(actual)) throw unavailable();
    const present = new Set(actual.map((file) => `${file.role}/${file.name}`));
    for (const row of rows) {
      const extension = EXTENSION[row.mime_type];
      const original = actual.find(
        (file) =>
          file.role === 'originals' && file.name === `${row.id}${extension}`,
      );
      if (
        !extension ||
        !original ||
        original.size !== row.size ||
        !present.has(`thumbnails/${row.id}.jpg`)
      )
        throw unavailable();
    }
    for (const deletion of deletions) {
      if (
        deletion.storage_id !== evidence.binding.storageId ||
        deletion.originals_binding_id !== evidence.binding.originalsBindingId ||
        deletion.thumbnails_binding_id !== evidence.binding.thumbnailsBindingId ||
        deletion.storage_layout_version !== 1 ||
        rows.some((row) => row.id === deletion.asset_id) ||
        !['.jpg', '.png', '.webp'].includes(deletion.original_extension) ||
        (deletion.completed_at !== null &&
          (present.has(
            `originals/${deletion.asset_id}${deletion.original_extension}`,
          ) ||
            present.has(`thumbnails/${deletion.asset_id}.jpg`)))
      )
        throw unavailable();
    }
    await assertControlledRecoveryDatabase(database, evidence);
    return evidence;
  } catch {
    throw unavailable();
  }
}
