import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  readFile,
  rename,
  rmdir,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerAssetAccess } from '../src/auth/asset-lockdown.js';
import { AuthSessionService } from '../src/auth/auth-session.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import { createHttpAdapter } from '../src/http-adapter.js';
import { LocalStorageService } from '../src/storage/local-storage.service.js';
import { M12ApplicationReadinessService } from '../src/storage/m12-application-readiness.service.js';
import { parseStorageMarker } from '../src/storage/storage-marker.js';
import { SchemaAwareImageStorageService } from '../src/storage/schema-aware-image-storage.service.js';
import { testConfig } from './helpers/integration-database.js';

const root = process.env.SAEFR_NATIVE_FIRST;
const nativeFixture =
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.EXPECTED_RUNNER_ENVIRONMENT === 'github-hosted' &&
  process.env.EXPECTED_RUNNER_OS === 'Linux' &&
  !!process.env.RUNNER_TEMP &&
  !!root?.startsWith(`${process.env.RUNNER_TEMP}/saefr-m12c-ext4.`);

describe.skipIf(!nativeFixture)(
  'M12 production composition over real sockets on disposable ext4 and PostgreSQL',
  () => {
    let database: DatabaseService;
    let app: NestFastifyApplication;
    let baseUrl: string;
    let production: ReturnType<typeof spawn> | undefined;
    let productionClosed: Promise<void> | undefined;
    let ownerCookie: string;
    let ownerCsrf: string;
    let foreignCookie: string;
    let foreignSessionId: string;
    let restrictedCookie: string;
    let original: Buffer;
    let ownerAsset: string;
    let uploadedAsset: string | undefined;
    const envKeys = [
      'POSTGRES_HOST',
      'POSTGRES_PORT',
      'POSTGRES_DB',
      'POSTGRES_USER',
      'POSTGRES_PASSWORD',
      'APP_ORIGIN',
      'NODE_ENV',
      'STORAGE_ROOT',
      'STORAGE_ID',
      'STORAGE_ORIGINALS_BINDING_ID',
      'STORAGE_THUMBNAILS_BINDING_ID',
      'STORAGE_ORIGINALS_PROFILE',
      'STORAGE_THUMBNAILS_PROFILE',
    ];
    const previous = Object.fromEntries(
      envKeys.map((key) => [key, process.env[key]]),
    );
    const origin = 'http://127.0.0.1:3000';
    const password = 'synthetic native fixture password';

    const headers = (cookie: string, unsafe = false) => ({
      Cookie: cookie,
      ...(unsafe ? { Origin: origin, 'X-CSRF-Token': ownerCsrf } : {}),
    });

    async function startProduction(
      extraEnv: NodeJS.ProcessEnv = {},
    ): Promise<string> {
      const reserved = createServer();
      await new Promise<void>((done) => reserved.listen(0, '127.0.0.1', done));
      const address = reserved.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      await new Promise<void>((done) => reserved.close(() => done()));
      production = spawn(process.execPath, ['dist/main.js'], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          HOST: '127.0.0.1',
          PORT: String(address.port),
          APP_ORIGIN: origin,
          POSTGRES_HOST: process.env.POSTGRES_HOST,
          POSTGRES_PORT: process.env.POSTGRES_PORT,
          POSTGRES_DB: process.env.POSTGRES_DB,
          POSTGRES_USER: process.env.POSTGRES_USER,
          POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
          STORAGE_ROOT: process.env.STORAGE_ROOT,
          STORAGE_ID: process.env.STORAGE_ID,
          STORAGE_ORIGINALS_BINDING_ID:
            process.env.STORAGE_ORIGINALS_BINDING_ID,
          STORAGE_THUMBNAILS_BINDING_ID:
            process.env.STORAGE_THUMBNAILS_BINDING_ID,
          STORAGE_ORIGINALS_PROFILE: process.env.STORAGE_ORIGINALS_PROFILE,
          STORAGE_THUMBNAILS_PROFILE: process.env.STORAGE_THUMBNAILS_PROFILE,
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const child = production;
      child.stdout?.resume();
      child.stderr?.resume();
      child.on('error', () => undefined);
      productionClosed = new Promise<void>((done) =>
        child.once('close', () => done()),
      );
      const url = `http://127.0.0.1:${address.port}`;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) break;
        try {
          if (
            (await fetch(`${url}/health`, { signal: AbortSignal.timeout(250) }))
              .ok
          )
            return url;
        } catch {
          // The compiled entrypoint is still initializing.
        }
        await new Promise((done) => setTimeout(done, 50));
      }
      await stopProduction();
      throw new Error('Compiled M12 entrypoint did not listen');
    }

    async function stopProduction(): Promise<void> {
      const child = production;
      if (!child) return;
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          productionClosed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Child shutdown timeout')),
              5000,
            );
          }),
        ]);
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        await productionClosed;
        throw error;
      } finally {
        clearTimeout(timer);
        production = undefined;
        productionClosed = undefined;
      }
    }

    beforeAll(async () => {
      if (!root || !nativeFixture)
        throw new Error('Native fixture unavailable');
      const config = testConfig();
      database = new DatabaseService(config);
      await migrateToLatest(database.db);
      const originals = parseStorageMarker(
        await readFile(join(root, 'originals', '.saefr-storage.json')),
      );
      const thumbnails = parseStorageMarker(
        await readFile(join(root, 'thumbnails', '.saefr-storage.json')),
      );
      for (const key of envKeys.filter((key) => key.startsWith('POSTGRES_')))
        process.env[key] = String(config.getOrThrow(key));
      Object.assign(process.env, {
        NODE_ENV: 'test',
        APP_ORIGIN: origin,
        STORAGE_ROOT: root,
        STORAGE_ID: originals.storage_id,
        STORAGE_ORIGINALS_BINDING_ID: originals.binding_id,
        STORAGE_THUMBNAILS_BINDING_ID: thumbnails.binding_id,
        STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
        STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
      });
      const { AppModule } = await import('../src/app.module.js');
      const fixture = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app =
        fixture.createNestApplication<NestFastifyApplication>(
          createHttpAdapter(),
        );
      registerAssetAccess(app);
      expect(app.get(LocalStorageService)).toBeInstanceOf(
        SchemaAwareImageStorageService,
      );
      await expect(app.get(AuthSessionService).assertReady()).resolves.toBe(
        'm12',
      );
      expect(await app.get(M12ApplicationReadinessService).assess()).toBe(
        'metadata-only',
      );
      // Keep the in-process fixture for provider inspection alongside the
      // separate compiled-main child-process coverage below.
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.getHttpServer().address();
      if (!address || typeof address === 'string')
        throw new Error('No loopback listener');
      baseUrl = `http://127.0.0.1:${address.port}`;
      const hash = await new PasswordService().hash(password);
      const sessions = app.get(AuthSessionService);
      for (const name of ['owner', 'foreign', 'restricted']) {
        const id = randomUUID();
        await database.db
          .insertInto('app_user')
          .values({
            id,
            username: `native-${name}-${id.slice(0, 8)}`,
            password_hash: hash,
            role: 'user',
            status: 'active',
            password_change_required: name === 'restricted',
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();
        const issued = await sessions.login(
          `native-${name}-${id.slice(0, 8)}`,
          password,
        );
        const cookie = `saefr_session_dev=${issued.credential}`;
        if (name === 'owner') {
          ownerCookie = cookie;
          ownerCsrf = issued.actor.csrfToken.toString('base64url');
          ownerAsset = randomUUID();
          original = await sharp({
            create: {
              width: 16,
              height: 16,
              channels: 3,
              background: '#226699',
            },
          })
            .jpeg()
            .toBuffer();
          await writeFile(
            join(root, 'originals', `${ownerAsset}.jpg`),
            original,
          );
          await writeFile(
            join(root, 'thumbnails', `${ownerAsset}.jpg`),
            original,
          );
          await database.db
            .insertInto('asset')
            .values({
              id: ownerAsset,
              owner_id: id,
              filename: 'native-synthetic.jpg',
              mime_type: 'image/jpeg',
              size: original.length,
              storage_path: join(root, 'originals', `${ownerAsset}.jpg`),
              created_at: new Date(),
            })
            .execute();
        } else if (name === 'foreign') {
          foreignCookie = cookie;
          foreignSessionId = issued.actor.sessionId;
        } else restrictedCookie = cookie;
      }
      baseUrl = await startProduction();
    }, 45_000);

    afterAll(async () => {
      await stopProduction();
      await app?.close();
      await database?.onModuleDestroy();
      if (root && nativeFixture) {
        for (const id of [ownerAsset, uploadedAsset]) {
          if (!id) continue;
          for (const role of ['originals', 'thumbnails'])
            await rm(join(root, role, `${id}.jpg`), { force: true });
        }
      }
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('keeps metadata available while unadopted and denies media and upload before parsing', async () => {
      const metadata = await fetch(`${baseUrl}/api/v1/assets/${ownerAsset}`, {
        headers: headers(ownerCookie),
      });
      expect(metadata.status).toBe(200);
      const media = await fetch(
        `${baseUrl}/api/v1/assets/${ownerAsset}/original`,
        { headers: headers(ownerCookie) },
      );
      expect(media.status).toBe(503);
      expect(media.headers.get('content-type')).toMatch(/^application\/json/);
      const upload = await fetch(`${baseUrl}/api/v1/assets/upload`, {
        method: 'POST',
        headers: {
          ...headers(ownerCookie, true),
          'Content-Type': 'multipart/form-data; boundary=native',
        },
        body: '--native--\r\n',
      });
      expect(upload.status).toBe(503);
    });

    it('serves only owner media after exact binding and preserves upload bytes', async () => {
      if (!root) throw new Error('Native root unavailable');
      const originals = parseStorageMarker(
        await readFile(join(root, 'originals', '.saefr-storage.json')),
      );
      const thumbnails = parseStorageMarker(
        await readFile(join(root, 'thumbnails', '.saefr-storage.json')),
      );
      await database.db
        .insertInto('storage_binding')
        .values({
          singleton: true,
          storage_id: originals.storage_id,
          originals_binding_id: originals.binding_id,
          thumbnails_binding_id: thumbnails.binding_id,
          storage_layout_version: 1,
        })
        .execute();
      await stopProduction();
      baseUrl = await startProduction();
      expect(await app.get(M12ApplicationReadinessService).assess()).toBe(
        'media-ready',
      );
      const media = await fetch(
        `${baseUrl}/api/v1/assets/${ownerAsset}/original`,
        { headers: headers(ownerCookie) },
      );
      expect(media.status).toBe(200);
      expect(media.headers.get('cache-control')).toBe('no-store');
      expect(media.headers.get('x-content-type-options')).toBe('nosniff');
      expect(media.headers.get('content-disposition')).toBe('inline');
      expect(Buffer.from(await media.arrayBuffer())).toEqual(original);
      const preview = await fetch(
        `${baseUrl}/api/v1/assets/${ownerAsset}/thumbnail`,
        { headers: headers(ownerCookie) },
      );
      expect(preview.status).toBe(200);
      expect(preview.headers.get('cache-control')).toBe('no-store');
      expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await preview.arrayBuffer())).toEqual(original);
      const foreign = await fetch(
        `${baseUrl}/api/v1/assets/${ownerAsset}/original`,
        { headers: headers(foreignCookie) },
      );
      expect(foreign.status).toBe(404);
      await database.db
        .updateTable('auth_session')
        .set({ expires_at: new Date(0) })
        .where('id', '=', foreignSessionId)
        .execute();
      const expired = await fetch(
        `${baseUrl}/api/v1/assets/${ownerAsset}/original`,
        { headers: headers(foreignCookie) },
      );
      expect(expired.status).toBe(401);
      const restricted = await fetch(
        `${baseUrl}/api/v1/assets/${ownerAsset}/original`,
        { headers: headers(restrictedCookie) },
      );
      expect(restricted.status).toBe(403);
      expect(
        (await fetch(`${baseUrl}/api/v1/assets/${ownerAsset}/original`)).status,
      ).toBe(401);

      const body = Buffer.concat([
        Buffer.from(
          '--native\r\nContent-Disposition: form-data; name="file"; filename="native.jpg"\r\nContent-Type: image/jpeg\r\n\r\n',
        ),
        original,
        Buffer.from('\r\n--native--\r\n'),
      ]);
      for (const invalid of [
        { Origin: undefined, 'X-CSRF-Token': ownerCsrf },
        { Origin: origin, 'X-CSRF-Token': undefined },
      ]) {
        const denied = await fetch(`${baseUrl}/api/v1/assets/upload`, {
          method: 'POST',
          headers: {
            Cookie: ownerCookie,
            'Content-Type': 'multipart/form-data; boundary=native',
            ...Object.fromEntries(
              Object.entries(invalid).filter(([, value]) => value),
            ),
          },
          body,
        });
        expect(denied.status).toBe(403);
      }
      const uploaded = await fetch(`${baseUrl}/api/v1/assets/upload`, {
        method: 'POST',
        headers: {
          ...headers(ownerCookie, true),
          'Content-Type': 'multipart/form-data; boundary=native',
        },
        body,
      });
      expect(uploaded.status).toBe(201);
      uploadedAsset = ((await uploaded.json()) as { id: string }).id;
      expect(
        await readFile(join(root, 'originals', `${uploadedAsset}.jpg`)),
      ).toEqual(original);
    });

    it('treats a wrong database-to-storage pairing as metadata-only', async () => {
      await stopProduction();
      baseUrl = await startProduction({ STORAGE_ID: randomUUID() });
      const metadata = await fetch(`${baseUrl}/api/v1/assets/${ownerAsset}`, {
        headers: headers(ownerCookie),
      });
      expect(metadata.status).toBe(200);
      const media = await fetch(
        `${baseUrl}/api/v1/assets/${ownerAsset}/original`,
        {
          headers: headers(ownerCookie),
        },
      );
      expect(media.status).toBe(503);
      expect(media.headers.get('content-type')).toMatch(/^application\/json/);
      await stopProduction();
      baseUrl = await startProduction();
    });

    it('fails closed when a role or helper disappears after startup', async () => {
      if (!root) throw new Error('Native root unavailable');
      const originals = join(root, 'originals');
      const marker = join(originals, '.saefr-storage.json');
      const heldMarker = `${marker}.held`;
      await rename(marker, heldMarker);
      try {
        const unavailable = await fetch(
          `${baseUrl}/api/v1/assets/${ownerAsset}/original`,
          { headers: headers(ownerCookie) },
        );
        expect(unavailable.status).toBe(503);
      } finally {
        await rename(heldMarker, marker);
      }
      const moved = join(root, 'originals-held');
      await rename(originals, moved);
      await mkdir(originals);
      try {
        const unavailable = await fetch(
          `${baseUrl}/api/v1/assets/${ownerAsset}/original`,
          { headers: headers(ownerCookie) },
        );
        expect(unavailable.status).toBe(503);
        expect(await app.get(M12ApplicationReadinessService).assess()).toBe(
          'metadata-only',
        );
      } finally {
        await rmdir(originals);
        await rename(moved, originals);
      }
      const helper = resolve(
        process.cwd(),
        'dist/native/storage-identity-observer',
      );
      const heldHelper = `${helper}.held`;
      await rename(helper, heldHelper);
      try {
        const unavailable = await fetch(
          `${baseUrl}/api/v1/assets/${ownerAsset}/original`,
          { headers: headers(ownerCookie) },
        );
        expect(unavailable.status).toBe(503);
        expect(await unavailable.text()).not.toMatch(
          /storage-identity-observer|\/tmp\//,
        );
      } finally {
        await rename(heldHelper, helper);
      }
    });
  },
);
