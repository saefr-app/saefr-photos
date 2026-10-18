import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AssetsRepository } from '../assets/assets.repository.js';
import { LocalStorageService } from '../storage/local-storage.service.js';
import { MAX_UPLOAD_BYTES } from '../storage/image-limits.js';
import { mlOptions, type MlOptions } from './ml-options.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Injectable()
export class MlBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MlBridgeService.name);
  private readonly options: MlOptions | null;
  private readonly pending = new Set<string>();
  private readonly shutdown = new AbortController();
  private initialized?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private closed = false;
  private cursor = 0;

  constructor(
    config: ConfigService,
    private readonly repository: AssetsRepository,
    private readonly storage: LocalStorageService,
  ) {
    this.options = mlOptions(config);
  }

  async onModuleInit(): Promise<void> {
    if (!this.options) return;
    try {
      await this.ensureState();
    } catch {
      this.logger.warn('ML pending-state initialization unavailable');
    }
    this.timer = setInterval(() => {
      void this.reconcile();
    }, 60_000);
    this.timer.unref();
    void this.reconcile();
  }
  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.shutdown.abort();
    await this.running;
  }
  private ensureState(): Promise<void> {
    this.initialized ??= this.initializeState();
    return this.initialized;
  }
  private async initializeState(): Promise<void> {
    const options = this.options!;
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    const ownerFile = join(options.stateDir, 'owner.json');
    const names = await readdir(options.stateDir);
    if (!names.includes('owner.json')) {
      if (names.length) throw new Error('Unrecognized ML pending state');
      const file = await open(ownerFile, 'wx', 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            application: 'saefr-ml-bridge',
            scope_id: options.scopeId,
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
    }
    const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as Record<
      string,
      unknown
    >;
    if (
      owner.application !== 'saefr-ml-bridge' ||
      owner.scope_id !== options.scopeId
    )
      throw new Error('ML scope mismatch');
    for (const name of await readdir(options.stateDir)) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!UUID.test(id)) continue;
      const record = JSON.parse(
        await readFile(join(options.stateDir, name), 'utf8'),
      ) as Record<string, unknown>;
      if (record.asset_id !== id || record.scope_id !== options.scopeId)
        throw new Error('Invalid ML pending record');
      this.pending.add(id);
    }
  }
  async notify(assetId: string): Promise<void> {
    if (!this.options || !UUID.test(assetId)) return;
    this.pending.add(assetId);
    try {
      await this.ensureState();
      const file = await open(
        join(this.options.stateDir, assetId + '.json'),
        'wx',
        0o600,
      ).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
        throw error;
      });
      if (file) {
        try {
          await file.writeFile(
            JSON.stringify({
              asset_id: assetId,
              scope_id: this.options.scopeId,
            }),
          );
          await file.sync();
        } finally {
          await file.close();
        }
      }
    } catch {
      this.logger.warn('ML capture pending; existing media preserved');
    }
  }
  private async completed(assetId: string): Promise<void> {
    await unlink(join(this.options!.stateDir, assetId + '.json')).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      },
    );
    this.pending.delete(assetId);
  }
  private async call(
    path: string,
    method = 'GET',
    body?: Uint8Array<ArrayBuffer>,
    mediaType?: string,
    generation?: number,
  ): Promise<Record<string, unknown> | null> {
    const options = this.options!;
    const response = await fetch(
      options.url + '/v1/scopes/' + options.scopeId + path,
      {
        method,
        redirect: 'error',
        signal: AbortSignal.any([
          this.shutdown.signal,
          AbortSignal.timeout(10_000),
        ]),
        headers: {
          Authorization: 'Bearer ' + options.token,
          ...(mediaType ? { 'Content-Type': mediaType } : {}),
          ...(generation ? { 'X-Asset-Generation': String(generation) } : {}),
        },
        ...(body === undefined ? {} : { body }),
      },
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('ML coordinator unavailable');
    }
    if (method === 'PUT' && response.status !== 202) {
      await response.body?.cancel();
      throw new Error('ML handoff unacknowledged');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.length;
        if (bytes > 32 * 1024) {
          await reader.cancel();
          throw new Error('Invalid ML response');
        }
        chunks.push(result.value);
      }
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid ML response');
    return value as Record<string, unknown>;
  }
  reconcile(): Promise<void> {
    if (!this.options || this.closed) return Promise.resolve();
    this.running ??= this.synchronize()
      .catch(() => {
        this.logger.warn('ML reconciliation pending; existing media preserved');
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async synchronize(): Promise<void> {
    await this.ensureState();
    const scope = await this.call('/status');
    if (scope?.enabled !== true) return;
    if (this.options!.backfill) {
      const assets = await this.repository.findAll();
      for (let n = 0; n < Math.min(100, assets.length); n++) {
        const asset = assets[(this.cursor + n) % assets.length];
        if (asset) await this.notify(asset.id);
      }
      this.cursor = assets.length ? (this.cursor + 100) % assets.length : 0;
    }
    for (const id of [...this.pending].slice(0, 25)) {
      if (this.closed) break;
      const status = await this.call('/assets/' + id);
      if (
        status &&
        (!['eligible', 'trashed', 'deleted'].includes(String(status.state)) ||
          typeof status.needs_input !== 'boolean' ||
          !Number.isSafeInteger(status.generation))
      )
        throw new Error('Invalid ML asset state');
      if (
        status &&
        (status.state !== 'eligible' || status.needs_input === false)
      ) {
        await this.completed(id);
        continue;
      }
      const check = await this.call('/status');
      if (check?.enabled !== true) return;
      const generation = status ? status.generation : 1;
      if (!Number.isSafeInteger(generation) || (generation as number) < 1)
        throw new Error('Invalid ML generation');
      const asset = await this.repository.findFileById(id);
      if (!asset) {
        await this.completed(id);
        continue;
      }
      const original = await this.storage.openOriginal(
        asset.id,
        asset.mime_type,
        asset.storage_path,
      );
      const timeout = setTimeout(() => {
        original.stream.destroy(new Error('ML source timeout'));
      }, 10_000);
      const abort = () => {
        original.stream.destroy(new Error('ML shutdown'));
      };
      this.shutdown.signal.addEventListener('abort', abort, { once: true });
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of original.stream) {
          const buffer = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk as Uint8Array);
          bytes += buffer.length;
          if (bytes > MAX_UPLOAD_BYTES) throw new Error('ML source limit');
          chunks.push(buffer);
        }
        if (!bytes || bytes !== original.size)
          throw new Error('Incomplete ML source');
        const ack = await this.call(
          '/assets/' + id,
          'PUT',
          new Uint8Array(Buffer.concat(chunks)),
          asset.mime_type,
          generation as number,
        );
        if (
          !ack ||
          ack.asset_id !== id ||
          ack.generation !== generation ||
          !ack.job ||
          typeof ack.job !== 'object'
        )
          throw new Error('ML handoff unacknowledged');
        await this.completed(id);
      } finally {
        clearTimeout(timeout);
        this.shutdown.signal.removeEventListener('abort', abort);
        original.stream.destroy();
      }
    }
  }
}
