import { isIP } from 'node:net';

export interface WorkerConfig {
  host: string;
  port: number;
  password?: string;
  tls: boolean;
  prefix: string;
  concurrency: number;
  controlIntervalMs: number;
}

export class WorkerConfigError extends Error {
  constructor(field: string) {
    super(`Invalid worker configuration: ${field}`);
    this.name = 'WorkerConfigError';
  }
}

function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  const raw = value ?? String(fallback);
  if (!/^[0-9]+$/.test(raw)) throw new WorkerConfigError(field);
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new WorkerConfigError(field);
  return number;
}

export function workerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const host = env.SAEFR_REDIS_HOST ?? '127.0.0.1';
  const port = integer(
    env.SAEFR_REDIS_PORT,
    6379,
    1,
    65535,
    'SAEFR_REDIS_PORT',
  );
  const tls = env.SAEFR_REDIS_TLS === 'true';
  if (
    env.SAEFR_REDIS_TLS !== undefined &&
    !['true', 'false'].includes(env.SAEFR_REDIS_TLS)
  ) {
    throw new WorkerConfigError('SAEFR_REDIS_TLS');
  }
  const dnsLabel = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  if (!(
    isIP(host) !== 0 ||
    (host.length <= 253 &&
      host.split('.').every((label) => dnsLabel.test(label)))
  )) {
    throw new WorkerConfigError('SAEFR_REDIS_HOST');
  }
  const password = env.SAEFR_REDIS_PASSWORD;
  if (password !== undefined && password.length === 0)
    throw new WorkerConfigError('SAEFR_REDIS_PASSWORD');
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(host) &&
    (!tls || !password)
  ) {
    throw new WorkerConfigError('remote Redis requires TLS and a password');
  }
  const prefix = env.SAEFR_REDIS_PREFIX ?? 'saefr:m13a';
  if (!/^[a-zA-Z0-9_-]{1,64}(?::[a-zA-Z0-9_-]{1,64})*$/.test(prefix)) {
    throw new WorkerConfigError('SAEFR_REDIS_PREFIX');
  }
  return {
    host,
    port,
    password,
    tls,
    prefix,
    concurrency: integer(
      env.SAEFR_WORKER_CONCURRENCY,
      1,
      1,
      4,
      'SAEFR_WORKER_CONCURRENCY',
    ),
    controlIntervalMs: integer(
      env.SAEFR_WORKER_CONTROL_INTERVAL_MS,
      60_000,
      100,
      60_000,
      'SAEFR_WORKER_CONTROL_INTERVAL_MS',
    ),
  };
}
