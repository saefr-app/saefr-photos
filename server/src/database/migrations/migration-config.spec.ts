import { describe, expect, it } from 'vitest';

import {
  migrationConfig,
  validateMigrationCommand,
} from './migration-config.js';
import { safeMigrationError } from './migration-runner.js';

const env = {
  MIGRATION_POSTGRES_HOST: '127.0.0.1',
  MIGRATION_POSTGRES_PORT: '5432',
  MIGRATION_POSTGRES_DB: 'example',
  MIGRATION_POSTGRES_USER: 'example',
  MIGRATION_POSTGRES_PASSWORD: 'test-only-password',
};

describe('Migration CLI safety', () => {
  it('does not fall back to application connection settings', () => {
    expect(() =>
      migrationConfig({ POSTGRES_DB: 'dev', POSTGRES_USER: 'dev' }),
    ).toThrow('MIGRATION_POSTGRES_HOST');
  });
  it.each(['0', '65536', '1.5', 'NaN', '5432extra'])(
    'rejects invalid port %s',
    (port) => {
      expect(() =>
        migrationConfig({ ...env, MIGRATION_POSTGRES_PORT: port }),
      ).toThrow('PORT');
    },
  );
  it('requires explicit database confirmation for writes', () => {
    expect(() => validateMigrationCommand(['up'], 'example')).toThrow(
      'confirm-database',
    );
    expect(() =>
      validateMigrationCommand(['up', '--confirm-database=dev'], 'example'),
    ).toThrow();
    expect(
      validateMigrationCommand(
        ['up', '--confirm-database=example', '--baseline-legacy'],
        'example',
      ),
    ).toEqual({ command: 'up', baselineLegacy: true });
  });
  it('rejects destructive, unknown and duplicate arguments', () => {
    for (const args of [
      ['down'],
      ['reset'],
      ['status', '--baseline-legacy'],
      ['up', '--force'],
      ['up', '--baseline-legacy', '--baseline-legacy'],
    ]) {
      expect(() => validateMigrationCommand(args, 'example')).toThrow();
    }
  });
  it('never renders raw driver error messages or secrets', () => {
    const error = Object.assign(new Error('password=secret private row'), {
      code: '42501',
    });
    expect(safeMigrationError(error)).toContain(
      'insufficient database privileges',
    );
    expect(safeMigrationError(error)).not.toContain('secret');
    expect(safeMigrationError(new Error('private row'))).not.toContain(
      'private row',
    );
  });
});
