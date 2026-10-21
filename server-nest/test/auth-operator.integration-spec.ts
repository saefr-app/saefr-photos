import { execFile as execFileCallback, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { type Kysely, sql } from 'kysely';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { PasswordService } from '../src/auth/password.service.js';
import type { Database } from '../src/database/database.types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import { OperatorAccountsService } from '../src/users/operator-accounts.service.js';
import {
  createOperatorDatabase,
  operatorDatabaseConfig,
} from '../src/users/operator-config.js';
import { UsersRepository } from '../src/users/users.repository.js';
import { testConfig } from './helpers/integration-database.js';

const execFile = promisify(execFileCallback);
const cliPath = resolve('dist/users/operator-cli.js');
const ptyPath = resolve('test/helpers/operator-pty.py');
const GOOD_PASSWORD = '  unique 🧩 phrase for tests  ';
const NEXT_PASSWORD = 'a second 🧩 recovery phrase';

describe('local authentication account operations on disposable PostgreSQL', () => {
  let admin: DatabaseService;
  let db: Kysely<Database>;
  let databaseName: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    const config = testConfig(); // Container identity, tmpfs and localhost port are verified here.
    admin = new DatabaseService(config);
    env = {
      AUTH_ADMIN_POSTGRES_HOST: '127.0.0.1',
      AUTH_ADMIN_POSTGRES_PORT: String(
        config.getOrThrow<number>('POSTGRES_PORT'),
      ),
      AUTH_ADMIN_POSTGRES_DB: '',
      AUTH_ADMIN_POSTGRES_USER: config.getOrThrow<string>('POSTGRES_USER'),
      AUTH_ADMIN_POSTGRES_PASSWORD:
        config.getOrThrow<string>('POSTGRES_PASSWORD'),
    };
  });

  beforeEach(async () => {
    databaseName = `saefr_m10_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(databaseName)}`.execute(admin.db);
    env.AUTH_ADMIN_POSTGRES_DB = databaseName;
    db = createOperatorDatabase(operatorDatabaseConfig(env));
    await migrateToLatest(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.destroy();
    if (databaseName)
      await sql`drop database ${sql.id(databaseName)}`.execute(admin.db);
  });

  afterAll(async () => {
    await admin?.onModuleDestroy();
  });

  async function rows() {
    return db.selectFrom('app_user').selectAll().orderBy('username').execute();
  }

  async function session(userId: string, expires: Date) {
    const id = randomUUID();
    await db
      .insertInto('auth_session')
      .values({
        id,
        user_id: userId,
        token_hash: Buffer.from(randomUUID().replaceAll('-', '').slice(0, 32)),
        csrf_token: Buffer.alloc(32, 2),
        created_at: new Date(Date.now() - 2 * 86_400_000),
        expires_at: expires,
      })
      .execute();
    return id;
  }

  function cliArgs(action: 'bootstrap' | 'recover' | 'prune', extra: string[]) {
    return [cliPath, action, `--confirm-database=${databaseName}`, ...extra];
  }

  function cliEnvironment(): NodeJS.ProcessEnv {
    // Do not pass inherited development POSTGRES_*, MIGRATION_POSTGRES_* or .env settings.
    return { PATH: process.env.PATH, LANG: 'C.UTF-8', ...env };
  }

  async function runPty(
    args: string[],
    password: string,
    confirmation = password,
  ) {
    return new Promise<{ code: number | null; output: string }>(
      (resolveResult, reject) => {
        const child = spawn('python3', [ptyPath, process.execPath, ...args], {
          env: cliEnvironment(),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          output += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          output += chunk;
        });
        child.once('error', reject);
        child.once('close', (code) => resolveResult({ code, output }));
        child.stdin.end(`${password}\n${confirmation}\n`);
      },
    );
  }

  async function failedCli(
    args: string[],
  ): Promise<{ code: number; stderr: string }> {
    try {
      await execFile(process.execPath, args, {
        env: cliEnvironment(),
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && 'stderr' in error)
        return { code: Number(error.code), stderr: String(error.stderr) };
      throw error;
    }
    throw new Error('Expected operator command to fail');
  }

  it('bootstraps exactly one canonical admin with a hash and never reopens after disable', async () => {
    const service = new OperatorAccountsService(db);
    const created = await service.bootstrapFirstAdmin(
      '  ADMIN  ',
      GOOD_PASSWORD,
    );
    expect(created).toMatchObject({
      username: 'admin',
      role: 'admin',
      status: 'active',
      password_change_required: false,
    });
    const [stored] = await rows();
    expect(stored.id).toBe(created.id);
    expect(stored.password_hash).not.toContain(GOOD_PASSWORD);
    expect(
      await new PasswordService().verify(GOOD_PASSWORD, stored.password_hash),
    ).toBe(true);
    await db
      .updateTable('app_user')
      .set({ status: 'disabled' })
      .where('id', '=', created.id)
      .execute();
    await expect(
      service.bootstrapFirstAdmin('otheradmin', NEXT_PASSWORD),
    ).rejects.toThrow('already initialized');
    expect(await rows()).toHaveLength(1);
  });

  it('serializes simultaneous bootstrap attempts from independent connections', async () => {
    const second = createOperatorDatabase(operatorDatabaseConfig(env));
    try {
      const results = await Promise.allSettled([
        new OperatorAccountsService(db).bootstrapFirstAdmin(
          'first',
          GOOD_PASSWORD,
        ),
        new OperatorAccountsService(second).bootstrapFirstAdmin(
          'second',
          NEXT_PASSWORD,
        ),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(await rows()).toHaveLength(1);
    } finally {
      await second.destroy();
    }
  });

  it('creates only ordinary accounts and rejects canonical duplicates', async () => {
    const service = new OperatorAccountsService(db);
    const first = await service.createOrdinaryUser('  Alice  ', GOOD_PASSWORD);
    expect(first).toMatchObject({
      username: 'alice',
      role: 'user',
      status: 'active',
      password_change_required: true,
    });
    await expect(
      service.createOrdinaryUser('ALICE', NEXT_PASSWORD),
    ).rejects.toThrow('Username already exists');
    expect(await rows()).toHaveLength(1);
    const credentials = await new UsersRepository(db).findCredentialsByUsername(
      'alice',
    );
    expect(credentials?.role).toBe('user');
    expect(
      await new PasswordService().verify(
        GOOD_PASSWORD,
        credentials?.password_hash,
      ),
    ).toBe(true);
  });

  it('recovers only the selected account and atomically revokes its sessions', async () => {
    const service = new OperatorAccountsService(db);
    const target = await service.createOrdinaryUser('target', GOOD_PASSWORD);
    const other = await service.createOrdinaryUser('another', GOOD_PASSWORD);
    await db
      .updateTable('app_user')
      .set({ status: 'disabled' })
      .where('id', '=', target.id)
      .execute();
    await session(target.id, new Date(Date.now() + 86_400_000));
    const otherSession = await session(
      other.id,
      new Date(Date.now() + 86_400_000),
    );
    const beforeOther = (await rows()).find((row) => row.id === other.id);
    expect(await service.recoverPassword(target.id, NEXT_PASSWORD)).toEqual({
      userId: target.id,
      revokedSessions: 1,
    });
    const afterTarget = (await rows()).find((row) => row.id === target.id);
    expect(afterTarget).toMatchObject({
      role: 'user',
      status: 'disabled',
      password_change_required: true,
    });
    expect(
      await new PasswordService().verify(
        NEXT_PASSWORD,
        afterTarget?.password_hash,
      ),
    ).toBe(true);
    expect(
      await new PasswordService().verify(
        GOOD_PASSWORD,
        afterTarget?.password_hash,
      ),
    ).toBe(false);
    expect((await rows()).find((row) => row.id === other.id)).toEqual(
      beforeOther,
    );
    expect(await db.selectFrom('auth_session').select('id').execute()).toEqual([
      { id: otherSession },
    ]);
    await expect(
      service.recoverPassword(randomUUID(), NEXT_PASSWORD),
    ).rejects.toThrow('not found');
  });

  it('rolls back password replacement when session revocation fails', async () => {
    const service = new OperatorAccountsService(db);
    const user = await service.createOrdinaryUser('rollback', GOOD_PASSWORD);
    await session(user.id, new Date(Date.now() + 86_400_000));
    const beforeUser = (await rows())[0];
    const beforeSessions = await db
      .selectFrom('auth_session')
      .select('id')
      .execute();
    vi.spyOn(UsersRepository.prototype, 'revokeSessions').mockRejectedValueOnce(
      new Error('injected revoke failure'),
    );
    await expect(
      service.recoverPassword(user.id, NEXT_PASSWORD),
    ).rejects.toThrow('injected revoke failure');
    expect((await rows())[0]).toEqual(beforeUser);
    expect(await db.selectFrom('auth_session').select('id').execute()).toEqual(
      beforeSessions,
    );
  });

  it('serializes simultaneous recovery of one account and keeps role and status', async () => {
    const service = new OperatorAccountsService(db);
    const user = await service.createOrdinaryUser('concurrent', GOOD_PASSWORD);
    await db
      .updateTable('app_user')
      .set({ status: 'disabled' })
      .where('id', '=', user.id)
      .execute();
    await session(user.id, new Date(Date.now() + 86_400_000));
    const second = createOperatorDatabase(operatorDatabaseConfig(env));
    try {
      const results = await Promise.all([
        service.recoverPassword(user.id, NEXT_PASSWORD),
        new OperatorAccountsService(second).recoverPassword(
          user.id,
          'third unique recovery password',
        ),
      ]);
      expect(
        results.reduce((count, result) => count + result.revokedSessions, 0),
      ).toBe(1);
      const [stored] = await rows();
      expect(stored).toMatchObject({
        role: 'user',
        status: 'disabled',
        password_change_required: true,
      });
      const passwords = new PasswordService();
      const matches = await Promise.all([
        passwords.verify(NEXT_PASSWORD, stored.password_hash),
        passwords.verify(
          'third unique recovery password',
          stored.password_hash,
        ),
      ]);
      expect(matches.filter(Boolean)).toHaveLength(1);
      expect(
        await db.selectFrom('auth_session').select('id').execute(),
      ).toEqual([]);
    } finally {
      await second.destroy();
    }
  });

  it('prunes only a bounded number of expired sessions using database time', async () => {
    const service = new OperatorAccountsService(db);
    const user = await service.createOrdinaryUser('pruneuser', GOOD_PASSWORD);
    const expired = [
      await session(user.id, new Date(Date.now() - 86_400_000)),
      await session(user.id, new Date(Date.now() - 86_400_000)),
    ];
    const live = await session(user.id, new Date(Date.now() + 86_400_000));
    expect(await service.pruneExpiredSessions(1)).toBe(1);
    expect(await service.pruneExpiredSessions(1)).toBe(1);
    expect(await service.pruneExpiredSessions(1)).toBe(0);
    expect(await db.selectFrom('auth_session').select('id').execute()).toEqual([
      { id: live },
    ]);
    expect(expired).not.toContain(live);
  });

  it('rejects missing or incompatible M10 schema before account operations', async () => {
    const service = new OperatorAccountsService(db);
    await db.schema.withSchema('public').dropTable('auth_session').execute();
    await expect(
      service.bootstrapFirstAdmin('admin', GOOD_PASSWORD),
    ).rejects.toThrow('Incompatible M10');
    expect(await rows()).toEqual([]);
    await db.schema
      .withSchema('public')
      .createTable('auth_session')
      .addColumn('id', 'uuid')
      .execute();
    await expect(service.pruneExpiredSessions(10)).rejects.toThrow(
      'Incompatible M10',
    );
    const cli = await failedCli(cliArgs('prune', ['--limit=10']));
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain('schema or migration history is incompatible');
    expect(await rows()).toEqual([]);
  });

  it('rejects mismatched hidden terminal input without creating an account', async () => {
    const attempt = await runPty(
      cliArgs('bootstrap', ['--username=admin']),
      GOOD_PASSWORD,
      NEXT_PASSWORD,
    );
    expect(attempt.code).toBe(1);
    expect(attempt.output).toContain('Passwords did not match');
    expect(attempt.output).not.toContain(GOOD_PASSWORD);
    expect(attempt.output).not.toContain(NEXT_PASSWORD);
    expect(await rows()).toEqual([]);
  });

  it('rejects nonterminal, wrong-target and password-argument CLI invocations safely', async () => {
    expect(
      Object.keys(cliEnvironment()).some(
        (key) =>
          key.startsWith('POSTGRES_') || key.startsWith('MIGRATION_POSTGRES_'),
      ),
    ).toBe(false);
    const noTerminal = await failedCli(
      cliArgs('bootstrap', ['--username=admin']),
    );
    expect(noTerminal).toMatchObject({ code: 1 });
    expect(String(noTerminal.stderr)).toContain('interactive terminal');
    const wrongTarget = await failedCli([
      cliPath,
      'bootstrap',
      '--confirm-database=wrong',
      '--username=admin',
    ]);
    expect(wrongTarget).toMatchObject({ code: 1 });
    expect(String(wrongTarget.stderr)).toContain('exact --confirm-database');
    const passwordArg = await failedCli(
      cliArgs('bootstrap', ['--username=admin', '--password=synthetic-secret']),
    );
    expect(passwordArg).toMatchObject({ code: 1 });
    expect(String(passwordArg.stderr)).not.toContain('synthetic-secret');
    expect(await rows()).toEqual([]);
  });

  it('runs bootstrap, recovery and pruning through real CLI processes and hidden PTY prompts', async () => {
    const boot = await runPty(
      cliArgs('bootstrap', ['--username=admin']),
      GOOD_PASSWORD,
    );
    expect(boot.code).toBe(0);
    expect(boot.output).toContain('Administrator created:');
    expect(boot.output).not.toContain(GOOD_PASSWORD);
    const [user] = await rows();
    await session(user.id, new Date(Date.now() - 86_400_000));
    const recover = await runPty(
      cliArgs('recover', [`--user-id=${user.id}`]),
      NEXT_PASSWORD,
    );
    expect(recover.code).toBe(0);
    expect(recover.output).toContain('sessions revoked: 1');
    expect(recover.output).not.toContain(NEXT_PASSWORD);
    expect(await db.selectFrom('auth_session').select('id').execute()).toEqual(
      [],
    );
    await session(user.id, new Date(Date.now() - 86_400_000));
    const pruned = await execFile(
      process.execPath,
      cliArgs('prune', ['--limit=1']),
      {
        env: cliEnvironment(),
      },
    );
    expect(pruned.stdout).toContain('Expired sessions removed: 1');
    expect(await db.selectFrom('auth_session').select('id').execute()).toEqual(
      [],
    );
  });
});
