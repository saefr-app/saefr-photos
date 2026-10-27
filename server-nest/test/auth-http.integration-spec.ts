import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { registerAssetAccess } from '../src/auth/asset-lockdown.js';
import { AuthSessionService } from '../src/auth/auth-session.service.js';
import { createHttpAdapter } from '../src/http-adapter.js';
import { PasswordService } from '../src/auth/password.service.js';
import { OperatorAccountsService } from '../src/users/operator-accounts.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { testConfig } from './helpers/integration-database.js';
import { migrateToM11 } from './helpers/m11-schema.js';

const origin = 'http://127.0.0.1:3000';
const password = 'isolated security test phrase';

describe('M10 browser authentication on disposable PostgreSQL and a real localhost socket', () => {
  let admin: DatabaseService;
  let database: DatabaseService;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let databaseName: string;
  let username: string;
  let userId: string;
  let passwordHash: string;
  const originalEnv = Object.fromEntries(
    [
      'POSTGRES_HOST',
      'POSTGRES_PORT',
      'POSTGRES_DB',
      'POSTGRES_USER',
      'POSTGRES_PASSWORD',
      'APP_ORIGIN',
      'NODE_ENV',
    ].map((key) => [key, process.env[key]]),
  );

  beforeAll(async () => {
    const config = testConfig(); // Verifies image, owner label, tmpfs, credential and localhost port.
    admin = new DatabaseService(config);
    databaseName = `saefr_m10_http_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(databaseName)}`.execute(admin.db);
    const isolated = new ConfigService({
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: config.getOrThrow<number>('POSTGRES_PORT'),
      POSTGRES_DB: databaseName,
      POSTGRES_USER: config.getOrThrow<string>('POSTGRES_USER'),
      POSTGRES_PASSWORD: config.getOrThrow<string>('POSTGRES_PASSWORD'),
    });
    database = new DatabaseService(isolated);
    await migrateToM11(database.db);
    passwordHash = await new PasswordService().hash(password);
    process.env.POSTGRES_HOST = '127.0.0.1';
    process.env.POSTGRES_PORT = String(
      config.getOrThrow<number>('POSTGRES_PORT'),
    );
    process.env.POSTGRES_DB = databaseName;
    process.env.POSTGRES_USER = config.getOrThrow<string>('POSTGRES_USER');
    process.env.POSTGRES_PASSWORD =
      config.getOrThrow<string>('POSTGRES_PASSWORD');
    process.env.APP_ORIGIN = origin;
    process.env.NODE_ENV = 'test';

    // Import only after the verified disposable target has replaced all app DB settings.
    const { AppModule } = await import('../src/app.module.js');
    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app =
      fixture.createNestApplication<NestFastifyApplication>(
        createHttpAdapter(),
      );
    registerAssetAccess(app);
    await app.get(AuthSessionService).assertReady();
    await app.init();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string')
      throw new Error('No localhost listener');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  beforeEach(async () => {
    await sql`delete from public.auth_session`.execute(database.db);
    await sql`delete from public.app_user`.execute(database.db);
    userId = randomUUID();
    username = `user${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await database.db
      .insertInto('app_user')
      .values({
        id: userId,
        username,
        password_hash: passwordHash,
        role: 'admin',
        status: 'active',
        password_change_required: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await database?.onModuleDestroy();
    if (databaseName)
      await sql`drop database ${sql.id(databaseName)}`.execute(admin.db);
    await admin?.onModuleDestroy();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function request(path: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, { redirect: 'manual', ...init });
  }

  async function login(secret = password) {
    const response = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Saefr-Login': '1',
      },
      body: JSON.stringify({ username, password: secret }),
    });
    const body = (await response.json()) as {
      csrfToken: string;
      user: { id: string };
      session: { id: string; expiresAt: string };
    };
    return {
      response,
      body,
      cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? '',
    };
  }

  function unsafe(cookie: string, csrf: string, body?: unknown): RequestInit {
    return {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? '{}' : JSON.stringify(body),
    };
  }

  it('issues only a hashed opaque credential and a secure browser response contract', async () => {
    const { response, body, cookie } = await login();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toContain(
      'HttpOnly; SameSite=Lax',
    );
    expect(cookie).toMatch(/^saefr_session_dev=[A-Za-z0-9_-]{43}$/);
    expect(body.user.id).toBe(userId);
    expect(body).not.toHaveProperty('passwordHash');
    expect(
      new Date(body.session.expiresAt).getTime() - Date.now(),
    ).toBeGreaterThan(6 * 86_400_000);
    const stored = await database.db
      .selectFrom('auth_session')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).toHaveLength(32);
    expect(stored.token_hash.toString('base64url')).not.toBe(
      cookie.split('=')[1],
    );
    expect(stored.csrf_token.toString('base64url')).toBe(body.csrfToken);
    const me = await request('/api/v1/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      id: userId,
      csrfToken: body.csrfToken,
      assetsAvailable: true,
    });
  });

  it('authenticates asset access and rejects upload without Origin/CSRF', async () => {
    const unauthenticated = await request('/api/v1/assets/id/original', {
      headers: { Range: 'bytes=0-5' },
    });
    expect(unauthenticated.status).toBe(401);
    const { cookie } = await login();
    const list = await request('/api/v1/assets', {
      headers: { Cookie: cookie },
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [], next_cursor: null });
    const invalidId = await request('/api/v1/assets/id/thumbnail', {
      headers: { Cookie: cookie },
    });
    expect(invalidId.status).toBe(400);
    const upload = await request('/api/v1/assets/upload', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'multipart/form-data; boundary=bad',
      },
      body: 'bad',
    });
    expect(upload.status).toBe(403);
    expect(upload.headers.get('content-range')).toBeNull();
  });

  it('requires exact Origin, JSON login header and rejects bearer credentials', async () => {
    for (const headers of [
      {
        Origin: 'https://elsewhere.test',
        'Content-Type': 'application/json',
        'X-Saefr-Login': '1',
      },
      { 'Content-Type': 'application/json', 'X-Saefr-Login': '1' },
      {
        Origin: 'null',
        'Content-Type': 'application/json',
        'X-Saefr-Login': '1',
      },
      { Origin: origin, 'Content-Type': 'application/json' },
    ] as Array<Record<string, string>>) {
      const response = await request('/api/v1/auth/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ username, password }),
      });
      expect([400, 403]).toContain(response.status);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    const { cookie } = await login();
    const bearer = await request('/api/v1/me', {
      headers: { Cookie: cookie, Authorization: 'Bearer private' },
    });
    expect(bearer.status).toBe(401);
    expect(await bearer.text()).not.toContain('private');
    expect(
      (
        await request('/api/v1/me', {
          headers: { Authorization: 'Bearer private' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request('/api/v1/me', {
          headers: { Cookie: cookie, 'Proxy-Authorization': 'Basic private' },
        })
      ).status,
    ).toBe(401);
  });

  it.each([
    [
      'malformed JSON',
      `{"username":"user","password":"private-auth-request-marker"`,
      400,
      'Bad Request',
      'Bad Request',
    ],
    [
      'oversized JSON',
      JSON.stringify({
        username: 'user',
        password: 'postgres://private.invalid/internal'.repeat(400),
      }),
      413,
      'Payload Too Large',
      'Payload Too Large',
    ],
  ] as const)(
    'sanitizes %s before the authentication controller runs',
    async (_case, body, status, message, error) => {
      const response = await request('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'X-Saefr-Login': '1',
        },
        body,
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ statusCode: status, message, error });
      expect(text).not.toContain('private-auth-request-marker');
      expect(text).not.toContain('postgres://private.invalid/internal');
      expect(text).not.toContain('FST_ERR_');
      expect(
        await database.db.selectFrom('auth_session').select('id').execute(),
      ).toEqual([]);
    },
  );

  it('requires independent CSRF and exact Origin for unsafe authenticated requests', async () => {
    const { cookie, body } = await login();
    const noCsrf = await request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
    });
    expect(noCsrf.status).toBe(403);
    for (const headers of [
      { Cookie: cookie, 'X-CSRF-Token': body.csrfToken },
      { Cookie: cookie, Origin: 'null', 'X-CSRF-Token': body.csrfToken },
      { Cookie: cookie, Origin: origin, 'X-CSRF-Token': 'invalid' },
    ] as Array<Record<string, string>>) {
      const response = await request('/api/v1/auth/logout', {
        method: 'POST',
        headers,
      });
      expect(response.status).toBe(403);
    }
    const foreign = await request('/api/v1/auth/logout', {
      ...unsafe(cookie, body.csrfToken),
      headers: {
        Cookie: cookie,
        Origin: 'https://foreign.test',
        'X-CSRF-Token': body.csrfToken,
      },
    });
    expect(foreign.status).toBe(403);
    expect(
      (await request('/api/v1/me', { headers: { Cookie: cookie } })).status,
    ).toBe(200);
    const logout = await request(
      '/api/v1/auth/logout',
      unsafe(cookie, body.csrfToken),
    );
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(
      (await request('/api/v1/me', { headers: { Cookie: cookie } })).status,
    ).toBe(401);
  });

  it('rejects expired sessions and disabled accounts on the next request', async () => {
    const first = await login();
    await database.db
      .updateTable('auth_session')
      .set({
        created_at: new Date(Date.now() - 2 * 86_400_000),
        expires_at: new Date(Date.now() - 86_400_000),
      })
      .where('id', '=', first.body.session.id)
      .execute();
    expect(
      (await request('/api/v1/me', { headers: { Cookie: first.cookie } }))
        .status,
    ).toBe(401);
    const second = await login();
    await database.db
      .updateTable('app_user')
      .set({ status: 'disabled' })
      .where('id', '=', userId)
      .execute();
    expect(
      (await request('/api/v1/me', { headers: { Cookie: second.cookie } }))
        .status,
    ).toBe(401);
    expect((await login()).response.status).toBe(401);
  });

  it('lists only own live sessions and revokes one or all with a user-row lock', async () => {
    const first = await login();
    const second = await login();
    const listed = await request('/api/v1/auth/sessions', {
      headers: { Cookie: first.cookie },
    });
    expect(listed.status).toBe(200);
    expect((await listed.json()) as unknown[]).toHaveLength(2);
    const revoke = await request(
      `/api/v1/auth/sessions/${second.body.session.id}`,
      {
        ...unsafe(first.cookie, first.body.csrfToken),
        method: 'DELETE',
      },
    );
    expect(revoke.status).toBe(204);
    expect(
      (await request('/api/v1/me', { headers: { Cookie: second.cookie } }))
        .status,
    ).toBe(401);
    const missing = await request(`/api/v1/auth/sessions/${randomUUID()}`, {
      ...unsafe(first.cookie, first.body.csrfToken),
      method: 'DELETE',
    });
    expect(missing.status).toBe(404);
    const otherId = randomUUID();
    const otherSessionId = randomUUID();
    await database.db
      .insertInto('app_user')
      .values({
        id: otherId,
        username: `other${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        password_hash: passwordHash,
        role: 'user',
        status: 'active',
        password_change_required: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await database.db
      .insertInto('auth_session')
      .values({
        id: otherSessionId,
        user_id: otherId,
        token_hash: Buffer.alloc(32, 77),
        csrf_token: Buffer.alloc(32, 78),
        created_at: new Date(),
        expires_at: new Date(Date.now() + 86_400_000),
      })
      .execute();
    const foreign = await request(`/api/v1/auth/sessions/${otherSessionId}`, {
      ...unsafe(first.cookie, first.body.csrfToken),
      method: 'DELETE',
    });
    expect(foreign.status).toBe(404);
    expect(
      await database.db
        .selectFrom('auth_session')
        .select('id')
        .where('id', '=', otherSessionId)
        .execute(),
    ).toHaveLength(1);
    const all = await request(
      '/api/v1/auth/logout-all',
      unsafe(first.cookie, first.body.csrfToken),
    );
    expect(all.status).toBe(204);
    expect(
      await database.db
        .selectFrom('auth_session')
        .select('id')
        .where('id', '=', otherSessionId)
        .execute(),
    ).toHaveLength(1);
    expect(
      (await request('/api/v1/me', { headers: { Cookie: first.cookie } }))
        .status,
    ).toBe(401);
  });

  it('uses a fifteen-minute restricted session and revokes it after password change', async () => {
    await database.db
      .updateTable('app_user')
      .set({ password_change_required: true })
      .where('id', '=', userId)
      .execute();
    const first = await login();
    expect(first.response.status).toBe(200);
    expect(
      new Date(first.body.session.expiresAt).getTime() - Date.now(),
    ).toBeLessThan(16 * 60_000);
    expect(
      (await request('/api/v1/me', { headers: { Cookie: first.cookie } }))
        .status,
    ).toBe(200);
    expect(
      (
        await request('/api/v1/auth/sessions', {
          headers: { Cookie: first.cookie },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request('/api/v1/users', {
          headers: { Cookie: first.cookie },
        })
      ).status,
    ).toBe(403);
    const changed = await request(
      '/api/v1/auth/password',
      unsafe(first.cookie, first.body.csrfToken, {
        currentPassword: password,
        newPassword: 'another isolated test phrase',
      }),
    );
    expect(changed.status).toBe(204);
    expect(
      (await request('/api/v1/me', { headers: { Cookie: first.cookie } }))
        .status,
    ).toBe(401);
    expect((await login()).response.status).toBe(401);
    expect((await login('another isolated test phrase')).response.status).toBe(
      200,
    );
    const updated = await database.db
      .selectFrom('app_user')
      .select('password_change_required')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(updated.password_change_required).toBe(false);
  });

  it('rejects an eleventh live session without revoking existing sessions', async () => {
    // Seed live sessions directly because the approved ten-attempt username
    // throttle would otherwise block the eleventh login before the cap check.
    for (let index = 0; index < 10; index++) {
      await database.db
        .insertInto('auth_session')
        .values({
          id: randomUUID(),
          user_id: userId,
          token_hash: Buffer.alloc(32, index),
          csrf_token: Buffer.alloc(32, index),
          created_at: new Date(),
          expires_at: new Date(Date.now() + 86_400_000),
        })
        .execute();
    }
    const extra = await login();
    expect(extra.response.status).toBe(409);
    expect(
      await database.db.selectFrom('auth_session').select('id').execute(),
    ).toHaveLength(10);
  }, 20_000);

  it('throttles repeated login attempts with a safe 429 and Retry-After', async () => {
    for (let index = 0; index < 10; index++)
      expect((await login('wrong isolated test phrase')).response.status).toBe(
        401,
      );
    const limited = await login('wrong isolated test phrase');
    expect(limited.response.status).toBe(429);
    expect(limited.response.headers.get('retry-after')).toBe('900');
    expect(JSON.stringify(limited.body)).not.toContain(
      'wrong isolated test phrase',
    );
  }, 20_000);

  it('fails closed and sanitizes an unexpected session lookup failure', async () => {
    const { cookie } = await login();
    vi.spyOn(app.get(AuthSessionService), 'resolve').mockRejectedValueOnce(
      new Error('postgres://private/path'),
    );
    const response = await request('/api/v1/me', {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('postgres://private/path');
    vi.restoreAllMocks();
  });

  it('serializes login against local recovery and leaves no old-credential session', async () => {
    const sessions = app.get(AuthSessionService);
    const recovery = new OperatorAccountsService(database.db);
    const results = await Promise.allSettled([
      sessions.login(username, password),
      recovery.recoverPassword(userId, 'recovered isolated test phrase'),
    ]);
    expect(results[1].status).toBe('fulfilled');
    if (results[0].status === 'fulfilled')
      expect(await sessions.resolve(results[0].value.credential)).toBeNull();
    expect(
      await database.db.selectFrom('auth_session').select('id').execute(),
    ).toEqual([]);
  });

  it('does not issue a session verified before logout-all commits', async () => {
    const sessions = app.get(AuthSessionService);
    const passwords = app.get(PasswordService);
    const current = await sessions.login(username, password);
    // A future timestamp forces the monotonic increment branch, independent
    // of wall-clock timing and JavaScript's millisecond precision.
    await database.db
      .updateTable('app_user')
      .set({ updated_at: new Date(Date.now() + 60_000) })
      .where('id', '=', userId)
      .execute();
    const revisionBefore = (
      await sql<{
        revision: string;
      }>`select extract(epoch from updated_at)::text as revision
        from public.app_user where id = ${userId}`.execute(database.db)
    ).rows[0].revision;
    const originalVerify = passwords.verifyOrDummy.bind(passwords);
    let signalVerified!: () => void;
    let resumeVerification!: () => void;
    const verified = new Promise<void>((resolve) => {
      signalVerified = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      resumeVerification = resolve;
    });
    const verification = vi
      .spyOn(passwords, 'verifyOrDummy')
      .mockImplementationOnce(async (...args) => {
        const result = await originalVerify(...args);
        signalVerified();
        await resume;
        return result;
      });

    const pending = sessions.login(username, password);
    try {
      await verified;
      await sessions.logoutAll(current.actor);
      const revisionAfter = (
        await sql<{
          revision: string;
        }>`select extract(epoch from updated_at)::text as revision
          from public.app_user where id = ${userId}`.execute(database.db)
      ).rows[0].revision;
      expect(revisionAfter).not.toBe(revisionBefore);
    } finally {
      resumeVerification();
      verification.mockRestore();
    }
    await expect(pending).rejects.toMatchObject({ reason: 'invalid' });
    expect(
      await database.db.selectFrom('auth_session').select('id').execute(),
    ).toEqual([]);
  }, 20_000);

  it('rejects missing authentication schema at readiness without running a migration', async () => {
    const emptyName = `saefr_m10_empty_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(emptyName)}`.execute(admin.db);
    const config = testConfig();
    const empty = new DatabaseService(
      new ConfigService({
        POSTGRES_HOST: '127.0.0.1',
        POSTGRES_PORT: config.getOrThrow<number>('POSTGRES_PORT'),
        POSTGRES_DB: emptyName,
        POSTGRES_USER: config.getOrThrow<string>('POSTGRES_USER'),
        POSTGRES_PASSWORD: config.getOrThrow<string>('POSTGRES_PASSWORD'),
      }),
    );
    try {
      await expect(
        new AuthSessionService(empty, new PasswordService()).assertReady(),
      ).rejects.toThrow();
      const relations = await sql<{
        name: string;
      }>`select tablename as name from pg_tables where schemaname='public'`.execute(
        empty.db,
      );
      expect(relations.rows).toEqual([]);
    } finally {
      await empty.onModuleDestroy();
      await sql`drop database ${sql.id(emptyName)}`.execute(admin.db);
    }
  });

  it('starts the compiled API only with ready M11 schema and shuts down on SIGTERM', async () => {
    const reserved = createServer();
    await new Promise<void>((resolve) =>
      reserved.listen(0, '127.0.0.1', resolve),
    );
    const address = reserved.address();
    if (!address || typeof address === 'string')
      throw new Error('No test port');
    const port = address.port;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const child = spawn(process.execPath, ['dist/main.js'], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        APP_ORIGIN: origin,
        POSTGRES_HOST: process.env.POSTGRES_HOST,
        POSTGRES_PORT: process.env.POSTGRES_PORT,
        POSTGRES_DB: databaseName,
        POSTGRES_USER: process.env.POSTGRES_USER,
        POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
        STORAGE_ROOT: '/tmp/saefr-m10-no-media-access',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(500),
          });
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* Process is still starting. */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ready).toBe(true);
      const locked = await fetch(`http://127.0.0.1:${port}/api/v1/assets`);
      expect(locked.status).toBe(401);
      child.kill('SIGTERM');
      const exit = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) =>
            child.once('close', (code, signal) => resolve({ code, signal })),
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Shutdown timeout')), 5000),
        ),
      ]);
      expect(exit.code === 0 || exit.signal === 'SIGTERM').toBe(true);
      expect(output).not.toContain(process.env.POSTGRES_PASSWORD);
      expect(output).not.toContain(databaseName);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 20_000);
});
