import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from '../database/database.types.js';
import { WorkerConfigError } from './worker-config.js';
import { maintenanceConfig } from './maintenance-config.js';
import { MaintenanceRuntime } from './maintenance-runtime.js';
import { MaintenanceReconciliationRepository } from './maintenance-reconciliation.repository.js';
import { MaintenanceRetryRepository } from './maintenance-retry.repository.js';
import { MaintenanceDeliveryRepository } from './maintenance-delivery.repository.js';
import { createMaintenanceRecoveryAuthorization } from './maintenance-recovery-authorization.js';
import { MaintenanceRecoveryService } from './maintenance-recovery.service.js';

export const MAINTENANCE_RUNTIME = Symbol('maintenance-runtime');

/** Dedicated opt-in metadata writer; never loads .env or uses application DB defaults. */
export function createMaintenanceRuntime(
  env: NodeJS.ProcessEnv,
): MaintenanceRuntime | null {
  const config = maintenanceConfig(env);
  if (!config.enabled) return null;
  const required = (key: string) => {
    const value = env[`MAINTENANCE_POSTGRES_${key}`];
    if (!value || value.trim() !== value)
      throw new WorkerConfigError(`MAINTENANCE_POSTGRES_${key}`);
    return value;
  };
  const port = required('PORT');
  if (!/^[1-9][0-9]*$/.test(port) || Number(port) > 65535)
    throw new WorkerConfigError('MAINTENANCE_POSTGRES_PORT');
  const options = {
    host: required('HOST'),
    port: Number(port),
    database: required('DB'),
    user: required('USER'),
    password: required('PASSWORD'),
  };
  // The writer and protected read-only permit probe must inspect the same database.
  for (const [key, value] of Object.entries(options)) {
    if (key === 'user' || key === 'password') continue;
    const suffix = key === 'database' ? 'DB' : key.toUpperCase();
    if (String(value) !== env[`RECOVERY_PERMIT_POSTGRES_${suffix}`])
      throw new WorkerConfigError('maintenance and permit database pairing');
  }
  const permit = createMaintenanceRecoveryAuthorization(env);
  const pool = new Pool({
    ...options,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
    statement_timeout: 5000,
    query_timeout: 7000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 1000,
    options: '-c search_path=pg_catalog,public -c lock_timeout=1000',
    application_name: 'saefr-maintenance-metadata',
  });
  // pg removes its idle listener while a client is checked out. Handle the
  // additional client event too; the query rejection still stops progress.
  pool.on('connect', (client) => {
    client.on('error', () =>
      console.error('Maintenance database connection unavailable'),
    );
  });
  pool.on('error', () => console.error('Maintenance database unavailable'));
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const coordinator = new MaintenanceReconciliationRepository(db);
  // No Redis client is constructed. The runtime always requests delivery:false.
  const disconnected = {
    inspect: async (): Promise<never> => {
      throw new Error('Recovery delivery not enabled');
    },
    enqueue: async (): Promise<never> => {
      throw new Error('Recovery delivery not enabled');
    },
  };
  const service = new MaintenanceRecoveryService(
    coordinator,
    new MaintenanceRetryRepository(db),
    new MaintenanceDeliveryRepository(db),
    permit.authorization,
    disconnected,
    config.pageSize,
  );
  return new MaintenanceRuntime(
    config,
    coordinator,
    permit.authorization,
    service,
    async () => {
      await Promise.all([db.destroy(), permit.close()]);
    },
  );
}
