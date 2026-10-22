import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RuntimeConfigError, validateRuntimeConfig } from './runtime-config.js';

const required = {
  APP_ORIGIN: 'http://127.0.0.1:3000',
  POSTGRES_DB: 'saefr_test',
  POSTGRES_USER: 'saefr_test',
  POSTGRES_PASSWORD: 'test-only-secret',
};

describe('validateRuntimeConfig', () => {
  it('uses local defaults without changing required database values', () => {
    expect(validateRuntimeConfig(required)).toMatchObject({
      ...required,
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: 5432,
      STORAGE_ROOT: resolve(process.cwd(), '../storage'),
    });
  });

  it('accepts explicit runtime settings and resolves a relative storage root', () => {
    expect(
      validateRuntimeConfig({
        ...required,
        NODE_ENV: 'production',
        APP_ORIGIN: 'https://photos.example.test',
        HOST: 'localhost',
        PORT: '4100',
        POSTGRES_HOST: 'db.internal',
        POSTGRES_PORT: '5433',
        STORAGE_ROOT: './test-storage',
      }),
    ).toMatchObject({
      NODE_ENV: 'production',
      HOST: 'localhost',
      PORT: 4100,
      POSTGRES_HOST: 'db.internal',
      POSTGRES_PORT: 5433,
      STORAGE_ROOT: resolve('./test-storage'),
    });
  });

  it.each(['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'])(
    'rejects a missing or blank %s without printing values',
    (key) => {
      for (const value of [undefined, '   ']) {
        const env: Record<string, unknown> = { ...required, [key]: value };

        expect(() => validateRuntimeConfig(env)).toThrow(
          new RuntimeConfigError(`${key} is required`),
        );
      }
    },
  );

  it.each(['PORT', 'POSTGRES_PORT'])(
    'rejects malformed or out-of-range %s',
    (key) => {
      for (const value of ['0', '65536', '-1', '1.5', '123abc', ' 5432']) {
        expect(() =>
          validateRuntimeConfig({ ...required, [key]: value }),
        ).toThrow(`${key} must be an integer from 1 to 65535`);
      }
    },
  );

  it.each([
    ['NODE_ENV', 'staging'],
    ['HOST', 'http://localhost'],
    ['HOST', 'bad..host'],
    ['POSTGRES_HOST', 'db host'],
    ['STORAGE_ROOT', ''],
    ['STORAGE_ROOT', 'bad\0path'],
  ])('rejects malformed %s', (key, value) => {
    expect(() => validateRuntimeConfig({ ...required, [key]: value })).toThrow(
      RuntimeConfigError,
    );
  });

  it('does not include a secret in validation errors', () => {
    const secret = 'private-test-password';

    try {
      validateRuntimeConfig({
        ...required,
        POSTGRES_PASSWORD: secret,
        PORT: 'invalid',
      });
      throw new Error('Expected configuration validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigError);
      expect(String(error)).not.toContain(secret);
    }
  });

  it.each([
    undefined,
    'http://photos.example.test',
    'https://photos.example.test/path',
    'https://photos.example.test/',
    'https://user:secret@photos.example.test',
    'https://*.example.test',
  ])('rejects unsafe APP_ORIGIN %s without echoing it', (origin) => {
    expect(() =>
      validateRuntimeConfig({ ...required, APP_ORIGIN: origin }),
    ).toThrow(RuntimeConfigError);
  });

  it('requires HTTPS origin in production', () => {
    expect(() =>
      validateRuntimeConfig({ ...required, NODE_ENV: 'production' }),
    ).toThrow('APP_ORIGIN');
    expect(
      validateRuntimeConfig({
        ...required,
        NODE_ENV: 'production',
        APP_ORIGIN: 'https://photos.example.test',
      }).APP_ORIGIN,
    ).toBe('https://photos.example.test');
  });
});
