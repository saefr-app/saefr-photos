import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuthSessionService } from '../src/auth/auth-session.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import { testConfig } from './helpers/integration-database.js';

describe('compiled production startup on disposable PostgreSQL', () => {
  let admin: DatabaseService;
  let database: DatabaseService;
  let databaseName: string;
  let root: string;
  let child: ChildProcess | undefined;
  let closed: Promise<number | null> | undefined;
  let output = '';

  beforeAll(() => {
    admin = new DatabaseService(testConfig());
  });

  async function fixture() {
    databaseName = `saefr_startup_${randomUUID().replaceAll('-', '')}`;
    root = await mkdtemp(join(tmpdir(), 'saefr-startup-'));
    await sql`create database ${sql.id(databaseName)}`.execute(admin.db);
    const config = testConfig();
    database = new DatabaseService(
      new ConfigService({
        POSTGRES_HOST: '127.0.0.1',
        POSTGRES_PORT: config.getOrThrow<number>('POSTGRES_PORT'),
        POSTGRES_DB: databaseName,
        POSTGRES_USER: config.getOrThrow<string>('POSTGRES_USER'),
        POSTGRES_PASSWORD: config.getOrThrow<string>('POSTGRES_PASSWORD'),
      }),
    );
  }

  async function reservePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No test port');
    await new Promise<void>((done) => server.close(() => done()));
    return address.port;
  }

  async function start(): Promise<string> {
    const config = testConfig();
    const port = await reservePort();
    output = '';
    child = spawn(process.execPath, ['dist/main.js'], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        APP_ORIGIN: 'http://127.0.0.1:3000',
        POSTGRES_HOST: '127.0.0.1',
        POSTGRES_PORT: String(config.getOrThrow<number>('POSTGRES_PORT')),
        POSTGRES_DB: databaseName,
        POSTGRES_USER: config.getOrThrow<string>('POSTGRES_USER'),
        POSTGRES_PASSWORD: config.getOrThrow<string>('POSTGRES_PASSWORD'),
        STORAGE_ROOT: root,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', () => undefined);
    closed = new Promise((done) => child?.once('close', (code) => done(code)));
    return `http://127.0.0.1:${port}`;
  }

  async function waitForListener(url: string): Promise<boolean> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child?.exitCode !== null) return false;
      try {
        if (
          (await fetch(`${url}/health`, { signal: AbortSignal.timeout(250) }))
            .ok
        )
          return true;
      } catch {
        // The compiled application is still starting.
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    return false;
  }

  afterEach(async () => {
    let shutdownError: unknown;
    if (child) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Child shutdown timeout')),
              5000,
            );
          }),
        ]);
      } catch (error) {
        shutdownError = error;
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        await closed;
      } finally {
        clearTimeout(timer);
        child = undefined;
        closed = undefined;
      }
    }
    await database?.onModuleDestroy();
    if (databaseName)
      await sql`drop database ${sql.id(databaseName)}`.execute(admin.db);
    if (root) await rm(root, { recursive: true, force: true });
    databaseName = '';
    root = '';
    if (shutdownError) throw shutdownError;
  });

  afterAll(async () => {
    await admin?.onModuleDestroy();
  });

  it.each([false, true])(
    'starts exact M12 for owner metadata but denies media with synthetic binding row=%s',
    async (populated) => {
      await fixture();
      await migrateToLatest(database.db);
      if (populated)
        await sql`insert into public.storage_binding values
          (true, '00000000-0000-4000-8000-000000000101',
           '00000000-0000-4000-8000-000000000102',
           '00000000-0000-4000-8000-000000000103', 1)`.execute(database.db);
      const userId = randomUUID();
      const assetId = randomUUID();
      const username = `startup_${userId.slice(0, 8)}`;
      const password = 'synthetic child process password';
      const hash = await new PasswordService().hash(password);
      await database.db
        .insertInto('app_user')
        .values({
          id: userId,
          username,
          password_hash: hash,
          role: 'user',
          status: 'active',
          password_change_required: false,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      await database.db
        .insertInto('asset')
        .values({
          id: assetId,
          owner_id: userId,
          filename: 'synthetic.jpg',
          mime_type: 'image/jpeg',
          size: 10,
          storage_path: join(root, 'originals', `${assetId}.jpg`),
          created_at: new Date(),
        })
        .execute();
      const issued = await new AuthSessionService(
        database,
        new PasswordService(),
      ).login(username, password);
      const headers = { Cookie: `saefr_session_dev=${issued.credential}` };
      const url = await start();
      expect(await waitForListener(url)).toBe(true);
      expect(
        (await fetch(`${url}/api/v1/assets/${assetId}`, { headers })).status,
      ).toBe(200);
      const media = await fetch(`${url}/api/v1/assets/${assetId}/original`, {
        headers,
      });
      expect(media.status).toBe(503);
      expect(media.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await media.text()).not.toContain(root);
      const upload = await fetch(`${url}/api/v1/assets/upload`, {
        method: 'POST',
        headers: {
          ...headers,
          Origin: 'http://127.0.0.1:3000',
          'X-CSRF-Token': issued.actor.csrfToken.toString('base64url'),
          'Content-Type': 'multipart/form-data; boundary=synthetic',
        },
        body: '--synthetic--\r\n',
      });
      expect(upload.status).toBe(503);
      expect(output).not.toContain(password);
      expect(output).not.toContain(root);
    },
    20_000,
  );

  it.each(['empty', 'partial'])(
    'refuses %s schema before listening',
    async (state) => {
      await fixture();
      if (state === 'partial') {
        await migrateToLatest(database.db);
        await sql`drop index public.asset_active_owner_created_id_idx`.execute(
          database.db,
        );
      }
      const url = await start();
      expect(await waitForListener(url)).toBe(false);
      expect(await closed).toBe(1);
      expect(output).toContain('Application startup failed');
      expect(output).not.toContain(root);
      expect(output).not.toContain(
        testConfig().getOrThrow<string>('POSTGRES_PASSWORD'),
      );
    },
    15_000,
  );
});
