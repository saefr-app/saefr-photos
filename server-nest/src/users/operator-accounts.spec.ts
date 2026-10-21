import { describe, expect, it } from 'vitest';

import { PasswordPolicyError } from '../auth/password.service.js';
import { MigrationSafetyError } from '../database/migrations/legacy-asset-schema.js';
import { safeOperatorError } from './operator-cli.js';
import { readConfirmedPassword } from './hidden-password.js';
import {
  boundedPruneLimit,
  exactUserId,
  OperatorAccountError,
} from './operator-accounts.service.js';
import {
  operatorDatabaseConfig,
  parseOperatorCommand,
} from './operator-config.js';
import { canonicalUsername, UsernameError } from './username.js';

const dedicatedEnv = {
  POSTGRES_DB: 'unrelated_development_database',
  AUTH_ADMIN_POSTGRES_HOST: '127.0.0.1',
  AUTH_ADMIN_POSTGRES_PORT: '6543',
  AUTH_ADMIN_POSTGRES_DB: 'isolated_auth_test',
  AUTH_ADMIN_POSTGRES_USER: 'operator_test',
  AUTH_ADMIN_POSTGRES_PASSWORD: 'synthetic-test-credential',
};

describe('operator account validation', () => {
  it('normalizes only valid canonical usernames', () => {
    expect(canonicalUsername('  Alice.Name_1  ')).toBe('alice.name_1');
    expect(canonicalUsername('a'.repeat(64))).toHaveLength(64);
    for (const value of [
      undefined,
      '',
      'ab',
      'a'.repeat(65),
      '.alice',
      'a b c',
      'álîce',
    ])
      expect(() => canonicalUsername(value)).toThrow(UsernameError);
  });

  it('requires a canonical UUID and bounded session cleanup', () => {
    const id = '4d541c20-2c0a-4e95-a4a0-46ae876ba4ce';
    expect(exactUserId(id)).toBe(id);
    expect(() => exactUserId(id.toUpperCase())).toThrow(OperatorAccountError);
    expect(() => exactUserId('alice')).toThrow(OperatorAccountError);
    expect(boundedPruneLimit(1)).toBe(1);
    expect(boundedPruneLimit(1000)).toBe(1000);
    for (const limit of [0, 1001, 1.5, '50', Number.NaN])
      expect(() => boundedPruneLimit(limit)).toThrow(OperatorAccountError);
  });

  it('uses only dedicated settings and exact target confirmation', () => {
    const config = operatorDatabaseConfig(dedicatedEnv);
    expect(config.database).toBe('isolated_auth_test');
    expect(config.port).toBe(6543);
    expect(() => operatorDatabaseConfig({ POSTGRES_DB: 'dev' })).toThrow(
      'AUTH_ADMIN_POSTGRES_PORT',
    );
    expect(() =>
      operatorDatabaseConfig({
        ...dedicatedEnv,
        AUTH_ADMIN_POSTGRES_PORT: '0',
      }),
    ).toThrow();
    expect(() =>
      operatorDatabaseConfig({
        ...dedicatedEnv,
        AUTH_ADMIN_POSTGRES_DB: ' dev ',
      }),
    ).toThrow();
    expect(() =>
      parseOperatorCommand(
        ['bootstrap', '--username=admin'],
        'isolated_auth_test',
      ),
    ).toThrow('confirm-database');
    expect(() =>
      parseOperatorCommand(
        [
          'recover',
          '--confirm-database=other',
          '--user-id=4d541c20-2c0a-4e95-a4a0-46ae876ba4ce',
        ],
        'isolated_auth_test',
      ),
    ).toThrow('confirm-database');
    expect(
      parseOperatorCommand(
        [
          'bootstrap',
          '--confirm-database=isolated_auth_test',
          '--username=admin',
        ],
        'isolated_auth_test',
      ),
    ).toEqual({ action: 'bootstrap', username: 'admin' });
    expect(
      parseOperatorCommand(
        ['prune', '--confirm-database=isolated_auth_test', '--limit=100'],
        'isolated_auth_test',
      ),
    ).toEqual({ action: 'prune', limit: 100 });
    for (const invalid of [
      [
        'bootstrap',
        '--confirm-database=isolated_auth_test',
        '--username=admin',
        '--password=secret',
      ],
      [
        'bootstrap',
        '--confirm-database=isolated_auth_test',
        '--username=admin',
        '--username=other',
      ],
      ['prune', '--confirm-database=isolated_auth_test', '--limit=all'],
    ])
      expect(() =>
        parseOperatorCommand(invalid, 'isolated_auth_test'),
      ).toThrow();
  });

  it('rejects non-terminal password input and redacts unknown errors', async () => {
    await expect(readConfirmedPassword()).rejects.toThrow(
      'interactive terminal',
    );
    expect(
      safeOperatorError(new Error('password=private postgres://private')),
    ).not.toMatch(/password=|postgres:\/\//);
    expect(
      safeOperatorError(new MigrationSafetyError('private path')),
    ).not.toContain('private');
    expect(safeOperatorError(new PasswordPolicyError())).toBe(
      'Password does not meet the local policy.',
    );
  });
});
