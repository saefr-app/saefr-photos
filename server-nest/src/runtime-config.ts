import { isIP } from 'node:net';
import { resolve } from 'node:path';

const NODE_ENV_VALUES = ['development', 'test', 'production'] as const;
const HOSTNAME_LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(`Invalid runtime configuration: ${message}`);
    this.name = 'RuntimeConfigError';
  }
}

function required(env: Record<string, unknown>, key: string): string {
  const value = env[key];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new RuntimeConfigError(`${key} is required`);
  }

  return value;
}

function optional(
  env: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  return env[key] === undefined ? fallback : required(env, key);
}

function port(
  env: Record<string, unknown>,
  key: string,
  fallback: string,
): number {
  const value = optional(env, key, fallback);

  if (!/^[0-9]+$/.test(value)) {
    throw new RuntimeConfigError(`${key} must be an integer from 1 to 65535`);
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new RuntimeConfigError(`${key} must be an integer from 1 to 65535`);
  }

  return parsed;
}

function hostname(value: string): boolean {
  return (
    isIP(value) !== 0 ||
    (value.length <= 253 &&
      value.split('.').every((label) => HOSTNAME_LABEL.test(label)))
  );
}

export function validateRuntimeConfig(
  env: Record<string, unknown>,
): Record<string, unknown> {
  const nodeEnv = optional(env, 'NODE_ENV', 'development');

  if (!NODE_ENV_VALUES.includes(nodeEnv as (typeof NODE_ENV_VALUES)[number])) {
    throw new RuntimeConfigError(
      'NODE_ENV must be development, test or production',
    );
  }

  const host = optional(env, 'HOST', '127.0.0.1');

  if (!hostname(host)) {
    throw new RuntimeConfigError('HOST must be an IP address or hostname');
  }

  const postgresHost = optional(env, 'POSTGRES_HOST', '127.0.0.1');

  if (!hostname(postgresHost)) {
    throw new RuntimeConfigError(
      'POSTGRES_HOST must be an IP address or hostname',
    );
  }

  const storageRoot = optional(
    env,
    'STORAGE_ROOT',
    resolve(process.cwd(), '../storage'),
  );

  if (storageRoot.includes('\0')) {
    throw new RuntimeConfigError('STORAGE_ROOT must be a valid path');
  }

  const origin = required(env, 'APP_ORIGIN');
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new RuntimeConfigError('APP_ORIGIN must be an exact origin');
  }
  if (
    parsedOrigin.origin !== origin ||
    !hostname(parsedOrigin.hostname.replace(/^\[|\]$/g, '')) ||
    !['http:', 'https:'].includes(parsedOrigin.protocol) ||
    parsedOrigin.username ||
    parsedOrigin.password ||
    (parsedOrigin.protocol === 'http:' &&
      (nodeEnv === 'production' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(parsedOrigin.hostname)))
  ) {
    throw new RuntimeConfigError('APP_ORIGIN must be an approved exact origin');
  }

  return {
    ...env,
    NODE_ENV: nodeEnv,
    HOST: host,
    PORT: port(env, 'PORT', '3000'),
    POSTGRES_HOST: postgresHost,
    POSTGRES_PORT: port(env, 'POSTGRES_PORT', '5432'),
    POSTGRES_DB: required(env, 'POSTGRES_DB'),
    POSTGRES_USER: required(env, 'POSTGRES_USER'),
    POSTGRES_PASSWORD: required(env, 'POSTGRES_PASSWORD'),
    STORAGE_ROOT: resolve(storageRoot),
    APP_ORIGIN: origin,
  };
}
