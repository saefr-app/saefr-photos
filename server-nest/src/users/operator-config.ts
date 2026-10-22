import { Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolConfig } from 'pg';

import type { Database } from '../database/database.types.js';

export class OperatorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function operatorDatabaseConfig(env: NodeJS.ProcessEnv): PoolConfig {
  const required = (name: string): string => {
    const value = env[`AUTH_ADMIN_POSTGRES_${name}`];
    if (!value || value !== value.trim())
      throw new OperatorConfigurationError(
        `AUTH_ADMIN_POSTGRES_${name} must be set without surrounding whitespace.`,
      );
    return value;
  };
  const portText = required('PORT');
  const port = Number(portText);
  if (!/^[0-9]+$/.test(portText) || port < 1 || port > 65535)
    throw new OperatorConfigurationError(
      'AUTH_ADMIN_POSTGRES_PORT must be an integer from 1 to 65535.',
    );
  return {
    host: required('HOST'),
    port,
    database: required('DB'),
    user: required('USER'),
    password: required('PASSWORD'),
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
    statement_timeout: 30000,
    options: '-c search_path=pg_catalog,public -c lock_timeout=5000',
    application_name: 'saefr-auth-operator',
  };
}

export function createOperatorDatabase(config: PoolConfig): Kysely<Database> {
  const pool = new Pool(config);
  pool.on('error', () => {
    console.error('Authentication operator database connection lost.');
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export type OperatorCommand =
  | { action: 'bootstrap'; username: string }
  | { action: 'recover'; userId: string }
  | { action: 'prune'; limit: number };

export function parseOperatorCommand(
  args: string[],
  database: string,
): OperatorCommand {
  const [action, ...flags] = args;
  const values = new Map<string, string>();
  for (const flag of flags) {
    const match = /^--([a-z-]+)=(.*)$/.exec(flag);
    if (!match || values.has(match[1]))
      throw new OperatorConfigurationError(
        'Invalid operator command arguments.',
      );
    values.set(match[1], match[2]);
  }
  if (values.get('confirm-database') !== database)
    throw new OperatorConfigurationError(
      'Operator command requires exact --confirm-database match.',
    );

  if (action === 'bootstrap' && values.size === 2 && values.has('username'))
    return { action, username: values.get('username')! };
  if (action === 'recover' && values.size === 2 && values.has('user-id'))
    return { action, userId: values.get('user-id')! };
  if (action === 'prune' && values.size === 2 && values.has('limit')) {
    const text = values.get('limit')!;
    if (!/^[0-9]+$/.test(text))
      throw new OperatorConfigurationError('Invalid session prune limit.');
    return { action, limit: Number(text) };
  }
  throw new OperatorConfigurationError('Invalid operator command arguments.');
}
