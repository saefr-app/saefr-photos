import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetsRepository } from '../assets/assets.repository.js';
import type { LocalStorageService } from '../storage/local-storage.service.js';
import { MlBridgeService } from './ml-bridge.service.js';
import { mlOptions } from './ml-options.js';

const scopeId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-000000000002';
const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of temporary.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(enabled = true, changes: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'saefr-ml-bridge-'));
  temporary.push(root);
  const config = new ConfigService({
    ML_ENABLED: String(enabled),
    HOST: '127.0.0.1',
    STORAGE_ROOT: join(root, 'originals'),
    ML_COORDINATOR_URL: 'http://127.0.0.1:8002',
    ML_COORDINATOR_TOKEN: 'test-management-token-'.repeat(2),
    ML_SCOPE_ID: scopeId,
    ML_BRIDGE_STATE_DIR: join(root, 'pending'),
    ...changes,
  });
  const findFileById = vi
    .fn()
    .mockResolvedValue({
      id: assetId,
      mime_type: 'image/png',
      storage_path: '/private/original',
    });
  const findAll = vi.fn().mockResolvedValue([{ id: assetId }]);
  const openOriginal = vi
    .fn()
    .mockImplementation(async () => ({
      stream: Readable.from([Buffer.from('synthetic')]),
      size: 9,
    }));
  const repository = { findFileById, findAll } as unknown as AssetsRepository;
  const storage = { openOriginal } as unknown as LocalStorageService;
  return {
    root,
    config,
    repository,
    storage,
    findFileById,
    findAll,
    openOriginal,
    service: new MlBridgeService(config, repository, storage),
  };
}
function responder({ disabled = false, rejected = false } = {}) {
  return vi
    .fn()
    .mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/status'))
        return new Response(JSON.stringify({ enabled: !disabled }));
      if (options?.method === 'PUT')
        return rejected
          ? new Response('{}', { status: 404 })
          : new Response(
              JSON.stringify({
                asset_id: assetId,
                generation: 1,
                job: { id: 'synthetic-job' },
              }),
              { status: 202 },
            );
      return new Response('{}', { status: 404 });
    });
}
describe('opt-in ML backend bridge', () => {
  it('is disabled by default and never reads files, metadata or the network', async () => {
    const f = await fixture(false);
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    await f.service.onModuleInit();
    await f.service.notify(assetId);
    await f.service.reconcile();
    await f.service.onModuleDestroy();
    expect(f.findAll).not.toHaveBeenCalled();
    expect(f.openOriginal).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it('rejects remote endpoints, non-loopback backend binding and pending state inside originals', async () => {
    const f = await fixture();
    for (const changes of [
      { ML_COORDINATOR_URL: 'http://example.com' },
      { HOST: '0.0.0.0' },
      { ML_BRIDGE_STATE_DIR: join(f.root, 'originals', 'pending') },
      { ML_BRIDGE_STATE_DIR: join(f.root, 'originals', '..pending') },
      { ML_ENABLED: 'yes' },
    ]) {
      const value = new ConfigService({
        ML_ENABLED: 'true',
        HOST: '127.0.0.1',
        ML_COORDINATOR_URL: 'http://127.0.0.1:8002',
        ML_COORDINATOR_TOKEN: 'test-management-token-'.repeat(2),
        ML_SCOPE_ID: scopeId,
        STORAGE_ROOT: join(f.root, 'originals'),
        ML_BRIDGE_STATE_DIR: join(f.root, 'pending'),
        ...changes,
      });
      expect(() => mlOptions(value)).toThrow(
        'Invalid ML integration configuration',
      );
    }
  });
  it('captures only newly approved assets and hands bytes to the scoped coordinator after metadata exists', async () => {
    const f = await fixture();
    const network = responder();
    vi.stubGlobal('fetch', network);
    await f.service.notify(assetId);
    await f.service.reconcile();
    expect(f.findAll).not.toHaveBeenCalled();
    expect(f.openOriginal).toHaveBeenCalledOnce();
    const upload = network.mock.calls.find(
      (call: unknown[]) => (call[1] as RequestInit).method === 'PUT',
    );
    expect(upload).toBeDefined();
    expect((upload![1] as RequestInit).headers).toMatchObject({
      'X-Asset-Generation': '1',
    });
    expect(
      (await readdir(join(f.root, 'pending'))).filter(
        (name) => name !== 'owner.json',
      ),
    ).toEqual([]);
    await f.service.onModuleDestroy();
  });
  it('retains pending records after a revoked/unacknowledged handoff and recovers them on restart', async () => {
    const f = await fixture();
    vi.stubGlobal('fetch', responder({ rejected: true }));
    await f.service.notify(assetId);
    await f.service.reconcile();
    await f.service.onModuleDestroy();
    expect(await readdir(join(f.root, 'pending'))).toContain(assetId + '.json');
    const recovered = new MlBridgeService(f.config, f.repository, f.storage);
    vi.stubGlobal('fetch', responder());
    await recovered.onModuleInit();
    await recovered.reconcile();
    await recovered.onModuleDestroy();
    expect(await readdir(join(f.root, 'pending'))).not.toContain(
      assetId + '.json',
    );
  });
  it('respects ML disable and does not read original bytes until the scope is enabled', async () => {
    const f = await fixture();
    vi.stubGlobal('fetch', responder({ disabled: true }));
    await f.service.notify(assetId);
    await f.service.reconcile();
    expect(f.openOriginal).not.toHaveBeenCalled();
    expect(await readdir(join(f.root, 'pending'))).toContain(assetId + '.json');
    await f.service.onModuleDestroy();
  });
});
