import { Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolConfig } from 'pg';

import { MigrationSafetyError } from './legacy-asset-schema.js';

export function migrationConfig(env: NodeJS.ProcessEnv): PoolConfig {
  const required = (key: string): string => {
    const value = env[`MIGRATION_POSTGRES_${key}`];
    if (!value?.trim())
      throw new MigrationSafetyError(
        `MIGRATION_POSTGRES_${key} is required; application POSTGRES_* settings and .env are not loaded.`,
      );
    return value;
  };
  const host = required('HOST');
  const portText = required('PORT');
  const port = Number(portText);
  if (
    !/^\d+$/.test(portText) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new MigrationSafetyError(
      'MIGRATION_POSTGRES_PORT must be an integer from 1 to 65535.',
    );
  }
  return {
    host,
    port,
    database: required('DB'),
    user: required('USER'),
    password: required('PASSWORD'),
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
    statement_timeout: 30000,
    options: '-c search_path=pg_catalog,public -c lock_timeout=5000',
    application_name: 'saefr-photos-migrations',
  };
}

export function createMigrationDatabase(config: PoolConfig): Kysely<unknown> {
  const pool = new Pool(config);
  pool.on('error', () => {
    // Never print connection strings, passwords, SQL parameters or database rows.
    console.error(
      'Migration connection lost; inspect PostgreSQL availability.',
    );
  });
  return new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}

export function validateMigrationCommand(
  args: string[],
  database: string,
): {
  command: 'status' | 'up';
  baselineLegacy: boolean;
} {
  const [command, ...flags] = args;
  if (command !== 'up' && command !== 'status') {
    throw new MigrationSafetyError(
      'Use db:status or db:migrate; no down/reset command is provided.',
    );
  }
  const baselineLegacy = flags.includes('--baseline-legacy');
  if (
    flags.some(
      (flag) =>
        flag !== '--baseline-legacy' &&
        flag !== `--confirm-database=${database}`,
    ) ||
    new Set(flags).size !== flags.length ||
    (command === 'status' && flags.length > 0)
  ) {
    throw new MigrationSafetyError(
      'Unknown, duplicate or invalid migration arguments.',
    );
  }
  if (command === 'up' && !flags.includes(`--confirm-database=${database}`)) {
    throw new MigrationSafetyError(
      'Migration requires --confirm-database matching MIGRATION_POSTGRES_DB.',
    );
  }
  return { command, baselineLegacy };
}
