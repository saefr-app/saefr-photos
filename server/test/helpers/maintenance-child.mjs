// Disposable process-lifecycle fixture only. Never imported by production composition.
import { execFileSync } from 'node:child_process';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { MaintenanceRuntime } from '../../dist/worker/maintenance-runtime.js';
import { maintenanceConfig } from '../../dist/worker/maintenance-config.js';
import { MaintenanceRecoveryService } from '../../dist/worker/maintenance-recovery.service.js';
import { MaintenanceRecoveryAuthorization } from '../../dist/worker/maintenance-recovery-authorization.js';
import { MaintenanceReconciliationRepository } from '../../dist/worker/maintenance-reconciliation.repository.js';
import { MaintenanceRetryRepository } from '../../dist/worker/maintenance-retry.repository.js';
import { MaintenanceDeliveryRepository } from '../../dist/worker/maintenance-delivery.repository.js';
import {
  DatabasePermitPairing,
  RecoveryPermitService,
} from '../../dist/worker/recovery-permit.service.js';
import { RecoveryPermitStore } from '../../dist/worker/recovery-permit-store.js';
import { StorageBindingVerifier } from '../../dist/storage/storage-binding.service.js';
import { locationFingerprint } from '../../dist/storage/storage-marker.js';

const id = process.env.SAEFR_M7_TEST_CONTAINER_ID;
if (!/^[a-f0-9]{64}$/.test(id ?? ''))
  throw new Error('Disposable runner required');
const item = JSON.parse(
  execFileSync('docker', ['inspect', id], { encoding: 'utf8', timeout: 5000 }),
)[0];
const env = new Map(
  item.Config.Env.map((v) => [
    v.slice(0, v.indexOf('=')),
    v.slice(v.indexOf('=') + 1),
  ]),
);
if (
  item.Id !== id ||
  item.Config.Image !== 'postgres:18' ||
  item.Name !==
    `/saefr-m7-test-${process.env.SAEFR_M7_TEST_DB?.slice('saefr_m7_'.length)}` ||
  item.Config.Labels['dev.saefr.purpose'] !== 'milestone-07-integration' ||
  !item.HostConfig.AutoRemove ||
  !item.HostConfig.Tmpfs?.['/var/lib/postgresql'] ||
  item.Mounts.some((m) => m.Type !== 'tmpfs') ||
  item.NetworkSettings.Ports['5432/tcp'][0].HostIp !== '127.0.0.1' ||
  item.NetworkSettings.Ports['5432/tcp'][0].HostPort !==
    process.env.SAEFR_M7_TEST_PORT ||
  env.get('POSTGRES_DB') !== process.env.SAEFR_M7_TEST_DB ||
  env.get('POSTGRES_USER') !== process.env.SAEFR_M7_TEST_USER ||
  env.get('POSTGRES_PASSWORD') !== process.env.SAEFR_M7_TEST_PASSWORD ||
  !/^saefr_delivery_[a-f0-9]{32}$/.test(
    process.env.SAEFR_MAINTENANCE_FIXTURE_DB ?? '',
  )
)
  throw new Error('Disposable process isolation failed');
const { root, binding } = JSON.parse(process.env.SAEFR_MAINTENANCE_FIXTURE);
if (!/^\/tmp\/saefr-delivery-permit-[A-Za-z0-9]+$/.test(root))
  throw new Error('Synthetic permit fixture required');
const db = new Kysely({
  dialect: new PostgresDialect({
    pool: new Pool({
      host: '127.0.0.1',
      port: Number(process.env.SAEFR_M7_TEST_PORT),
      database: process.env.SAEFR_MAINTENANCE_FIXTURE_DB,
      user: process.env.SAEFR_M7_TEST_USER,
      password: process.env.SAEFR_M7_TEST_PASSWORD,
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      query_timeout: 7000,
    }),
  }),
});
const store = new RecoveryPermitStore({
  path: `${root}/permit.json`,
  operatorUid: process.geteuid(),
  readerGid: process.getegid(),
  restoreRoots: [`${root}/media`],
});
// Explicit synthetic physical observer and operator reader, matching the combined fixtures.
const physical = {
  async observe(role, location) {
    const identity = {
      format: 'linux-ext4-handle-v1',
      profile: 'linux-ext4-v1',
      filesystem_uuid: binding.storage_id,
      directory_handle_type: 1,
      directory_handle_hex: '01020304',
    };
    return {
      markerBytes: Buffer.from(
        JSON.stringify({
          version: 2,
          storage_id: binding.storage_id,
          binding_id:
            role === 'originals'
              ? binding.originals_binding_id
              : binding.thumbnails_binding_id,
          role,
          physical_identity: {
            ...identity,
            location_sha256: locationFingerprint(location, role),
          },
        }),
      ),
      identity,
    };
  },
};
const verifier = new StorageBindingVerifier(
  { db },
  new ConfigService({
    STORAGE_ROOT: `${root}/media`,
    STORAGE_ID: binding.storage_id,
    STORAGE_ORIGINALS_BINDING_ID: binding.originals_binding_id,
    STORAGE_THUMBNAILS_BINDING_ID: binding.thumbnails_binding_id,
    STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
    STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
  }),
  physical,
);
const authorization = new MaintenanceRecoveryAuthorization(
  new RecoveryPermitService(
    { readRuntime: () => store.readOperator() },
    new DatabasePermitPairing(db, verifier),
  ),
);
const coordinator = new MaintenanceReconciliationRepository(db);
const service = new MaintenanceRecoveryService(
  coordinator,
  new MaintenanceRetryRepository(db),
  new MaintenanceDeliveryRepository(db),
  authorization,
  {
    inspect: async () => {
      throw new Error('No producer in passive fixture');
    },
    enqueue: async () => {
      throw new Error('No producer in passive fixture');
    },
  },
  1,
);
const runtime = new MaintenanceRuntime(
  maintenanceConfig({ SAEFR_MAINTENANCE_ENABLED: 'true' }),
  coordinator,
  authorization,
  service,
  () => db.destroy(),
);
let stopped;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    stopped ??= runtime.stop().then((ok) => {
      console.log('maintenance-fixture-stopped');
      process.exitCode = ok ? 0 : 1;
    });
  });
runtime.start();
await runtime.tick();
console.log('maintenance-fixture-ready');
