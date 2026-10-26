import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
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
import { AttemptLimiter } from '../src/auth/attempt-limiter.js';
import { AuthSessionService } from '../src/auth/auth-session.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import { createHttpAdapter } from '../src/http-adapter.js';
import { DatabaseService } from '../src/database/database.service.js';
import { UsersService } from '../src/users/users.service.js';
import { testConfig } from './helpers/integration-database.js';
import { migrateToM11 } from './helpers/m11-schema.js';

const origin = 'http://127.0.0.1:3000';
const password = 'isolated admin test phrase';
const newPassword = 'isolated initial test phrase';

describe('M10 administrator routes on disposable PostgreSQL and localhost HTTP', () => {
  let admin: DatabaseService;
  let database: DatabaseService;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let databaseName: string;
  let adminId: string;
  let adminName: string;
  let passwordHash: string;
  const envKeys = [
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_DB',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'APP_ORIGIN',
    'NODE_ENV',
  ];
  const originalEnv = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  );

  beforeAll(async () => {
    const config = testConfig();
    admin = new DatabaseService(config);
    databaseName = `saefr_m10_users_${randomUUID().replaceAll('-', '')}`;
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
    vi.restoreAllMocks();
    // Login and reauthentication throttling has its own tests. These cases
    // exercise authorization/concurrency without a shared IP budget.
    vi.spyOn(app.get(AttemptLimiter), 'take').mockImplementation(() => {});
    await sql`delete from public.auth_session`.execute(database.db);
    await sql`delete from public.app_user`.execute(database.db);
    adminId = randomUUID();
    adminName = `admin${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertUser(adminId, adminName, 'admin');
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

  async function insertUser(
    id: string,
    username: string,
    role: 'admin' | 'user',
    restricted = false,
  ) {
    await database.db
      .insertInto('app_user')
      .values({
        id,
        username,
        password_hash: passwordHash,
        role,
        status: 'active',
        password_change_required: restricted,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  }

  async function request(path: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, { redirect: 'manual', ...init });
  }

  async function login(username = adminName, secret = password) {
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
      session: { id: string };
    };
    return {
      response,
      body,
      cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? '',
    };
  }

  function post(
    cookie: string,
    csrf: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): RequestInit {
    return {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    };
  }

  it('creates only an ordinary restricted account and projects safe public fields', async () => {
    const actor = await login();
    const created = await request(
      '/api/v1/users',
      post(actor.cookie, actor.body.csrfToken, {
        username: '  New.User  ',
        initialPassword: newPassword,
        currentPassword: password,
      }),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const body = (await created.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      username: 'new.user',
      role: 'user',
      status: 'active',
      passwordChangeRequired: true,
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        'createdAt',
        'id',
        'passwordChangeRequired',
        'role',
        'status',
        'updatedAt',
        'username',
      ].sort(),
    );
    expect(JSON.stringify(body)).not.toContain(newPassword);
    expect(JSON.stringify(body)).not.toContain(passwordHash);
    const stored = await database.db
      .selectFrom('app_user')
      .selectAll()
      .where('username', '=', 'new.user')
      .executeTakeFirstOrThrow();
    expect(stored.password_change_required).toBe(true);
    expect(stored.role).toBe('user');
    const firstLogin = await login('  NEW.USER  ', newPassword);
    expect(firstLogin.response.status).toBe(200);
    expect(
      (
        await request('/api/v1/assets', {
          headers: { Cookie: firstLogin.cookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/api/v1/users', {
          headers: { Cookie: firstLogin.cookie },
        })
      ).status,
    ).toBe(403);
  });

  it('rejects canonical duplicates, invalid usernames, weak passwords and malformed bodies', async () => {
    const actor = await login();
    const send = (body: unknown) =>
      request('/api/v1/users', post(actor.cookie, actor.body.csrfToken, body));
    expect(
      (
        await send({
          username: '  ADMIN' + adminName.slice(5) + ' ',
          initialPassword: newPassword,
          currentPassword: password,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await send({
          username: '../invalid',
          initialPassword: newPassword,
          currentPassword: password,
        })
      ).status,
    ).toBe(400);
    for (const username of ['Kevin', 'аdmin', 'Ａdmin']) {
      expect(
        (
          await send({
            username,
            initialPassword: newPassword,
            currentPassword: password,
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await send({
          username: 'validuser',
          initialPassword: 'short',
          currentPassword: password,
        })
      ).status,
    ).toBe(400);
    for (const body of [
      { username: 'validuser', initialPassword: newPassword },
      {
        username: 'validuser',
        initialPassword: newPassword,
        currentPassword: password,
        role: 'admin',
      },
      {
        username: 'validuser',
        initialPassword: newPassword,
        currentPassword: 123,
      },
    ])
      expect((await send(body)).status).toBe(400);
    expect(
      await database.db.selectFrom('app_user').select('id').execute(),
    ).toHaveLength(1);
  }, 20_000);

  it('requires current administrator password and prevents role, restricted and anonymous access', async () => {
    const actor = await login();
    const wrong = await request(
      '/api/v1/users',
      post(actor.cookie, actor.body.csrfToken, {
        username: 'createduser',
        initialPassword: newPassword,
        currentPassword: 'incorrect admin phrase',
      }),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain('incorrect admin phrase');
    const userId = randomUUID();
    await insertUser(userId, 'regularuser', 'user');
    const ordinary = await login('regularuser');
    const restrictedId = randomUUID();
    await insertUser(restrictedId, 'restrictedadmin', 'admin', true);
    const restricted = await login('restrictedadmin');
    for (const credential of [ordinary, restricted]) {
      expect(
        (
          await request('/api/v1/users', {
            headers: { Cookie: credential.cookie },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(
            '/api/v1/users',
            post(credential.cookie, credential.body.csrfToken, {
              username: 'otheruser',
              initialPassword: newPassword,
              currentPassword: password,
            }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await request(
            `/api/v1/users/${adminId}/disable`,
            post(credential.cookie, credential.body.csrfToken, {
              currentPassword: password,
            }),
          )
        ).status,
      ).toBe(403);
    }
    expect((await request('/api/v1/users')).status).toBe(401);
  }, 20_000);

  it('lists accounts in stable order with bounded pagination and no sensitive fields', async () => {
    await insertUser(randomUUID(), 'alphauser', 'user');
    await insertUser(randomUUID(), 'betauser', 'user');
    const actor = await login();
    const first = await request('/api/v1/users?limit=2&offset=0', {
      headers: { Cookie: actor.cookie },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({
      limit: 2,
      offset: 0,
      items: [{ username: adminName }, { username: 'alphauser' }],
    });
    const next = await request('/api/v1/users?limit=2&offset=2', {
      headers: { Cookie: actor.cookie },
    });
    expect(await next.json()).toMatchObject({
      limit: 2,
      offset: 2,
      items: [{ username: 'betauser' }],
    });
    expect(JSON.stringify(firstBody)).not.toContain(passwordHash);
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=-1',
      'limit=1.5',
      'offset=-1',
      'offset=NaN',
      'limit=1&extra=1',
    ])
      expect(
        (
          await request(`/api/v1/users?${query}`, {
            headers: { Cookie: actor.cookie },
          })
        ).status,
      ).toBe(400);
  });

  it('requires Origin and CSRF on both mutations', async () => {
    const actor = await login();
    const body = {
      username: 'newuser',
      initialPassword: newPassword,
      currentPassword: password,
    };
    for (const path of [
      '/api/v1/users',
      `/api/v1/users/${randomUUID()}/disable`,
    ]) {
      const data = path.endsWith('disable')
        ? { currentPassword: password }
        : body;
      const wrong = await request(
        path,
        post(actor.cookie, actor.body.csrfToken, data, {
          'X-CSRF-Token': 'wrong',
        }),
      );
      expect(wrong.status).toBe(403);
      const missingHeaders = post(actor.cookie, actor.body.csrfToken, data);
      delete (missingHeaders.headers as Record<string, string>)['X-CSRF-Token'];
      expect((await request(path, missingHeaders)).status).toBe(403);
      const foreign = await request(
        path,
        post(actor.cookie, actor.body.csrfToken, data, {
          Origin: 'https://foreign.invalid',
        }),
      );
      expect(foreign.status).toBe(403);
    }
    expect(
      await database.db.selectFrom('app_user').select('id').execute(),
    ).toHaveLength(1);
  });

  it('disables an ordinary user, revokes sessions and rejects subsequent login', async () => {
    const targetId = randomUUID();
    await insertUser(targetId, 'disabletarget', 'user');
    const target = await login('disabletarget');
    const actor = await login();
    const response = await request(
      `/api/v1/users/${targetId}/disable`,
      post(actor.cookie, actor.body.csrfToken, { currentPassword: password }),
    );
    expect(response.status).toBe(204);
    expect(
      (await request('/api/v1/me', { headers: { Cookie: target.cookie } }))
        .status,
    ).toBe(401);
    expect((await login('disabletarget')).response.status).toBe(401);
    expect(
      await database.db
        .selectFrom('auth_session')
        .select('id')
        .where('user_id', '=', targetId)
        .execute(),
    ).toEqual([]);
    expect(
      (
        await database.db
          .selectFrom('app_user')
          .select('status')
          .where('id', '=', targetId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('disabled');
    expect(
      (
        await request('/api/v1/assets/id/original', {
          headers: { Cookie: actor.cookie },
        })
      ).status,
    ).toBe(400);
  }, 20_000);

  it('sanitizes unknown targets, wrong passwords, invalid UUIDs and self-disable', async () => {
    const actor = await login();
    const unknown = randomUUID();
    const wrong = await request(
      `/api/v1/users/${unknown}/disable`,
      post(actor.cookie, actor.body.csrfToken, {
        currentPassword: 'wrong admin phrase',
      }),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain(unknown);
    expect(
      (
        await request(
          `/api/v1/users/${unknown}/disable`,
          post(actor.cookie, actor.body.csrfToken, {
            currentPassword: password,
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/api/v1/users/${adminId}/disable`,
          post(actor.cookie, actor.body.csrfToken, {
            currentPassword: password,
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          '/api/v1/users/invalid/disable',
          post(actor.cookie, actor.body.csrfToken, {
            currentPassword: password,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/v1/users/${unknown}/disable`,
          post(actor.cookie, actor.body.csrfToken, {}),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await database.db
          .selectFrom('app_user')
          .select('status')
          .where('id', '=', adminId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('active');
  }, 20_000);

  it('serializes concurrent cross-disables so one active administrator survives', async () => {
    const otherId = randomUUID();
    await insertUser(otherId, 'secondadmin', 'admin');
    const first = await login();
    const second = await login('secondadmin');
    let releaseLock!: () => void;
    let signalLocked!: () => void;
    let signalBothStarted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const bothStarted = new Promise<void>((resolve) => {
      signalBothStarted = resolve;
    });
    const blocker = database.db.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(708202610210004::bigint)`.execute(
        transaction,
      );
      signalLocked();
      await release;
    });
    await locked;
    const service = app.get(UsersService);
    const original = service.disable.bind(service);
    let started = 0;
    const spy = vi
      .spyOn(service, 'disable')
      .mockImplementation(async (...args) => {
        started++;
        if (started === 2) signalBothStarted();
        return original(...args);
      });
    const requests = Promise.all([
      request(
        `/api/v1/users/${otherId}/disable`,
        post(first.cookie, first.body.csrfToken, { currentPassword: password }),
      ),
      request(
        `/api/v1/users/${adminId}/disable`,
        post(second.cookie, second.body.csrfToken, {
          currentPassword: password,
        }),
      ),
    ]);
    let a: Response;
    let b: Response;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bothStarted,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Disable calls did not both start')),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      releaseLock();
    }
    await blocker;
    [a, b] = await requests;
    spy.mockRestore();
    expect([a.status, b.status].sort((left, right) => left - right)).toEqual([
      204, 401,
    ]);
    const active = await database.db
      .selectFrom('app_user')
      .select('id')
      .where('role', '=', 'admin')
      .where('status', '=', 'active')
      .execute();
    expect(active).toHaveLength(1);
  }, 20_000);

  it('rejects a login verified before the account-disable transaction commits', async () => {
    const targetId = randomUUID();
    await insertUser(targetId, 'racinguser', 'user');
    const actor = await login();
    const sessions = app.get(AuthSessionService);
    const passwords = app.get(PasswordService);
    const original = passwords.verifyOrDummy.bind(passwords);
    let verified!: () => void;
    let resume!: () => void;
    const atVerification = new Promise<void>((resolve) => {
      verified = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const spy = vi
      .spyOn(passwords, 'verifyOrDummy')
      .mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        verified();
        await release;
        return result;
      });
    const pending = sessions.login('racinguser', password);
    try {
      await atVerification;
      const disabled = await request(
        `/api/v1/users/${targetId}/disable`,
        post(actor.cookie, actor.body.csrfToken, { currentPassword: password }),
      );
      expect(disabled.status).toBe(204);
    } finally {
      resume();
      spy.mockRestore();
    }
    await expect(pending).rejects.toMatchObject({ reason: 'invalid' });
    expect(
      await database.db
        .selectFrom('auth_session')
        .select('id')
        .where('user_id', '=', targetId)
        .execute(),
    ).toEqual([]);
  }, 20_000);

  it('rejects stale reauthentication after an administrator password change', async () => {
    const actor = await login();
    const passwords = app.get(PasswordService);
    const sessions = app.get(AuthSessionService);
    const original = passwords.verify.bind(passwords);
    let verifying!: () => void;
    let resume!: () => void;
    const atVerification = new Promise<void>((resolve) => {
      verifying = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const spy = vi
      .spyOn(passwords, 'verify')
      .mockImplementationOnce(async (...args) => {
        verifying();
        await release;
        return original(...args);
      });
    const changing = sessions.changePassword(
      {
        userId: adminId,
        username: adminName,
        role: 'admin',
        sessionId: actor.body.session.id,
        expiresAt: new Date(Date.now() + 60_000),
        passwordChangeRequired: false,
        csrfToken: Buffer.alloc(32),
      },
      password,
      'replacement admin test phrase',
    );
    try {
      await atVerification;
      const pending = app.get(UsersService).create(
        {
          userId: adminId,
          username: adminName,
          role: 'admin',
          sessionId: actor.body.session.id,
          expiresAt: new Date(Date.now() + 60_000),
          passwordChangeRequired: false,
          csrfToken: Buffer.alloc(32),
        },
        'stalecreated',
        newPassword,
        password,
      );
      resume();
      await changing;
      await expect(pending).rejects.toMatchObject({ reason: 'invalid' });
      expect(
        await database.db
          .selectFrom('app_user')
          .select('id')
          .where('username', '=', 'stalecreated')
          .execute(),
      ).toEqual([]);
    } finally {
      resume();
      spy.mockRestore();
    }
  }, 20_000);

  it('sanitizes an unexpected account-query failure without private details', async () => {
    const actor = await login();
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const spy = vi
      .spyOn(app.get(UsersService), 'list')
      .mockRejectedValueOnce(new Error('postgres://private.invalid/internal'));
    const response = await request('/api/v1/users', {
      headers: { Cookie: actor.cookie },
    });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('postgres://private.invalid/internal');
    expect(JSON.parse(text)).toEqual({
      statusCode: 503,
      message: 'Database unavailable',
      error: 'Service Unavailable',
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(
      'postgres://private.invalid/internal',
    );
    spy.mockRestore();
    logged.mockRestore();
  });

  it.each(['create', 'disable'] as const)(
    'throttles real administrator reauthentication for %s',
    async (operation) => {
      const targetId = randomUUID();
      if (operation === 'disable')
        await insertUser(targetId, 'throttletarget', 'user');
      const actor = await login();
      expect(actor.response.status).toBe(200);
      // Restore the real limiter after login; each case has a fresh admin ID.
      // Together the cases remain below the independent 30-attempt IP budget.
      vi.restoreAllMocks();
      const path =
        operation === 'create'
          ? '/api/v1/users'
          : `/api/v1/users/${targetId}/disable`;
      const body = (currentPassword: string) =>
        operation === 'create'
          ? {
              username: 'throttleduser',
              initialPassword: newPassword,
              currentPassword,
            }
          : { currentPassword };
      const wrongPassword = 'private wrong administrator phrase';
      for (let attempt = 0; attempt < 10; attempt++) {
        const denied = await request(
          path,
          post(actor.cookie, actor.body.csrfToken, body(wrongPassword)),
        );
        expect(denied.status).toBe(401);
      }
      const throttled = await request(
        path,
        post(actor.cookie, actor.body.csrfToken, body(password)),
      );
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get('retry-after')).toBe('900');
      expect(throttled.headers.get('content-type')).toContain(
        'application/json',
      );
      const responseText = await throttled.text();
      expect(JSON.parse(responseText)).toEqual({
        statusCode: 429,
        message: 'Too many requests',
        error: 'Too Many Requests',
      });
      for (const secret of [wrongPassword, password, newPassword, passwordHash])
        expect(responseText).not.toContain(secret);
      if (operation === 'create') {
        expect(
          await database.db
            .selectFrom('app_user')
            .select('id')
            .where('username', '=', 'throttleduser')
            .execute(),
        ).toEqual([]);
      } else {
        expect(
          (
            await database.db
              .selectFrom('app_user')
              .select('status')
              .where('id', '=', targetId)
              .executeTakeFirstOrThrow()
          ).status,
        ).toBe('active');
      }
    },
    30_000,
  );
});
