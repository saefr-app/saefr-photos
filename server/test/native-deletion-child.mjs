import { ConfigService } from '@nestjs/config';

import { AssetDeletionExecutor } from '../dist/assets/asset-deletion.executor.js';
import { AssetDeletionRepository } from '../dist/assets/asset-deletion.repository.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { LinuxPhysicalStorageObserver } from '../dist/storage/linux-physical-storage.observer.js';
import { LocalStorageProvider } from '../dist/storage/local-storage.provider.js';
import { StorageBindingVerifier } from '../dist/storage/storage-binding.service.js';

const [assetId, ownerId, point] = process.argv.slice(2);
if (
  process.env.SAEFR_NATIVE_TEST_CHILD !== '1' ||
  process.env.GITHUB_ACTIONS !== 'true' ||
  process.env.EXPECTED_RUNNER_ENVIRONMENT !== 'github-hosted' ||
  process.env.EXPECTED_RUNNER_OS !== 'Linux' ||
  !process.env.RUNNER_TEMP ||
  !process.env.STORAGE_ROOT?.startsWith(
    `${process.env.RUNNER_TEMP}/saefr-m12c-ext4.`,
  ) ||
  process.env.POSTGRES_HOST !== '127.0.0.1' ||
  !/^saefr_m7_[0-9a-f]{12}$/.test(process.env.POSTGRES_DB ?? '') ||
  !['BEFORE_REMOVE', 'ORIGINAL_DONE', 'BOTH_DONE'].includes(point)
) {
  throw new Error('Disposable native deletion fixture required');
}

const config = new ConfigService({
  POSTGRES_HOST: process.env.POSTGRES_HOST,
  POSTGRES_PORT: Number(process.env.POSTGRES_PORT),
  POSTGRES_DB: process.env.POSTGRES_DB,
  POSTGRES_USER: process.env.POSTGRES_USER,
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
  STORAGE_ROOT: process.env.STORAGE_ROOT,
  STORAGE_ID: process.env.STORAGE_ID,
  STORAGE_ORIGINALS_BINDING_ID: process.env.STORAGE_ORIGINALS_BINDING_ID,
  STORAGE_THUMBNAILS_BINDING_ID: process.env.STORAGE_THUMBNAILS_BINDING_ID,
  STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
  STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
});
const database = new DatabaseService(config);
const verifier = new StorageBindingVerifier(
  database,
  config,
  new LinuxPhysicalStorageObserver(),
);
class PausingProvider extends LocalStorageProvider {
  async removeExact(target, expected) {
    if (point === 'BEFORE_REMOVE' && target.role === 'originals') {
      process.stdout.write('BEFORE_REMOVE\n');
      await new Promise(() => setInterval(() => undefined, 1_000));
    }
    const outcome = await super.removeExact(target, expected);
    if (
      outcome.durable &&
      ((point === 'ORIGINAL_DONE' && target.role === 'originals') ||
        (point === 'BOTH_DONE' && target.role === 'thumbnails'))
    ) {
      process.stdout.write(`${point}\n`);
      await new Promise(() => setInterval(() => undefined, 1_000));
    }
    return outcome;
  }
}
const executor = new AssetDeletionExecutor(
  new AssetDeletionRepository(database),
  new PausingProvider(verifier, config),
);
await executor.execute(assetId, ownerId);
throw new Error('Deletion child did not reach the expected kill point');
