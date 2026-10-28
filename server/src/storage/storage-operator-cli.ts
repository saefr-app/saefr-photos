import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { ConfigService } from '@nestjs/config';

import { DatabaseService } from '../database/database.service.js';
import { getMigrationStatus } from '../database/migrations/migration-runner.js';
import {
  ASSET_LIFECYCLE_MIGRATION,
  ASSET_OWNERSHIP_MIGRATION,
  AUTHENTICATION_MIGRATION,
  INITIAL_ASSET_MIGRATION,
} from '../database/migrations/migration-provider.js';
import { LinuxPhysicalStorageObserver } from './linux-physical-storage.observer.js';
import { StorageBindingProvisioner } from './storage-binding-provisioner.js';
import { StorageBindingVerifier } from './storage-binding.service.js';

function required(name: string): string {
  const value = process.env[`STORAGE_OPERATOR_${name}`];
  if (!value || value.trim() !== value)
    throw new Error('Storage operator configuration unavailable');
  return value;
}

async function main(): Promise<void> {
  const [action, databaseFlag, rootFlag, stoppedFlag, backupFlag] =
    process.argv.slice(2);
  const databaseName = required('POSTGRES_DB');
  const root = required('ROOT');
  const adopting = action === 'adopt-historical';
  const recovering = action === 'reestablish-location';
  if (
    (action !== 'provision-fresh' && !adopting && !recovering) ||
    databaseFlag !== `--confirm-database=${databaseName}` ||
    rootFlag !== `--confirm-root=${root}` ||
    (adopting || recovering
      ? stoppedFlag !== `--confirm-services-stopped=${databaseName}` ||
        backupFlag !==
          `--confirm-backup-record=${required('BACKUP_RECORD_SHA256')}`
      : stoppedFlag !== undefined || backupFlag !== undefined) ||
    process.argv.length !== (adopting || recovering ? 7 : 5) ||
    !isAbsolute(root) ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  )
    throw new Error(
      'Interactive exact database and root confirmation required',
    );
  const port = Number(required('POSTGRES_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Storage operator configuration unavailable');

  const identity = recovering
    ? {
        storageId: required('STORAGE_ID'),
        originalsBindingId: required('ORIGINALS_BINDING_ID'),
        thumbnailsBindingId: required('THUMBNAILS_BINDING_ID'),
      }
    : {
        storageId: randomUUID(),
        originalsBindingId: randomUUID(),
        thumbnailsBindingId: randomUUID(),
      };
  const config = new ConfigService({
    POSTGRES_HOST: required('POSTGRES_HOST'),
    POSTGRES_PORT: port,
    POSTGRES_DB: databaseName,
    POSTGRES_USER: required('POSTGRES_USER'),
    POSTGRES_PASSWORD: required('POSTGRES_PASSWORD'),
    STORAGE_ROOT: root,
    STORAGE_ID: identity.storageId,
    STORAGE_ORIGINALS_BINDING_ID: identity.originalsBindingId,
    STORAGE_THUMBNAILS_BINDING_ID: identity.thumbnailsBindingId,
    STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
    STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
  });
  const database = new DatabaseService(config);
  try {
    const status = await getMigrationStatus(database.db);
    if (
      ![
        INITIAL_ASSET_MIGRATION,
        AUTHENTICATION_MIGRATION,
        ASSET_OWNERSHIP_MIGRATION,
        ASSET_LIFECYCLE_MIGRATION,
      ].every((name) =>
        status.migrations.some(
          (migration) => migration.name === name && migration.applied,
        ),
      )
    )
      throw new Error('Storage schema unavailable');
    const observer = new LinuxPhysicalStorageObserver();
    const verifier = new StorageBindingVerifier(database, config, observer);
    const provisioner = new StorageBindingProvisioner(
      database,
      config,
      observer,
      observer,
      verifier,
    );
    if (adopting) {
      await provisioner.adoptHistorical(
        required('EVIDENCE_PATH'),
        identity,
        required('BACKUP_RECORD_SHA256'),
      );
    } else if (recovering) {
      await provisioner.reestablishControlledLocation(
        required('EVIDENCE_PATH'),
        required('BACKUP_RECORD_SHA256'),
      );
    } else {
      await provisioner.provisionFresh(identity);
    }
    if (!recovering) console.log(JSON.stringify(identity));
    else console.log('Storage location verified');
  } finally {
    await database.onModuleDestroy();
  }
}

if (process.argv[1]?.endsWith('/storage/storage-operator-cli.js')) {
  try {
    await main();
  } catch {
    // Never reveal credentials, paths, SQL details or physical identities.
    console.error(
      'Storage provisioning unavailable; inspect operator prerequisites.',
    );
    process.exitCode = 1;
  }
}
