import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  statfs,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LinuxPhysicalStorageObserver } from './linux-physical-storage.observer.js';

const EXT4_SUPER_MAGIC = 0xef53;
const TMPFS_MAGIC = 0x01021994;

describe.runIf(process.platform === 'linux')(
  'descriptor-only Linux physical observation',
  () => {
    let root: string;
    let helper: string;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'saefr-native-observer-'));
      helper = join(root, 'observer');
      const built = spawnSync(
        'cc',
        [
          '-std=c11',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-O2',
          'native/storage-identity-observer.c',
          '-o',
          helper,
        ],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      if (built.status !== 0)
        throw new Error('Native helper compilation failed');
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('requires a preopened directory and never accepts a path argument', () => {
      expect(spawnSync(helper, ['--identity']).status).toBe(2);
      expect(spawnSync(helper, ['--identity', root]).status).toBe(2);
    });

    it('rejects a non-ext4 role directory without a pathname fallback', async () => {
      const temporaryType = (await statfs(root)).type;
      const parent = temporaryType === EXT4_SUPER_MAGIC ? '/dev/shm' : root;
      if (parent === '/dev/shm')
        expect((await statfs(parent)).type).toBe(TMPFS_MAGIC);

      const directory = await mkdtemp(join(parent, 'saefr-non-ext4-'));
      try {
        const role = await realpath(directory);
        expect((await statfs(role)).type).not.toBe(EXT4_SUPER_MAGIC);
        const observer = new LinuxPhysicalStorageObserver(helper);
        await expect(
          observer.observeIdentity('originals', role),
        ).rejects.toThrow('Physical identity observation unavailable');
        await expect(observer.observe('originals', role)).rejects.toThrow(
          'Physical identity observation unavailable',
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('rejects symlinked directory ancestors before invoking the helper', async () => {
      const actual = join(root, 'actual');
      await mkdir(actual);
      await symlink(actual, join(root, 'redirect'));
      const observer = new LinuxPhysicalStorageObserver(helper);
      await expect(
        observer.observeIdentity('originals', join(root, 'redirect')),
      ).rejects.toThrow('Physical identity observation unavailable');
    });

    it('rejects malformed, excessive and conflicting helper output', async () => {
      const fake = join(root, 'fake');
      const observer = new LinuxPhysicalStorageObserver(fake);
      for (const output of [
        '{}',
        'x'.repeat(5000),
        JSON.stringify({
          filesystem_uuid: '11111111-1111-4111-8111-111111111111',
          directory_handle_type: 1,
          directory_handle_hex: 'aa',
          marker_hex: 'aa',
          extra: true,
        }),
      ]) {
        await writeFile(fake, `#!/bin/sh\nprintf '%s' '${output}'\n`);
        await chmod(fake, 0o700);
        await expect(observer.observe('originals', root)).rejects.toThrow(
          'Physical identity observation unavailable',
        );
      }
    });

    it('decodes a bounded synthetic helper protocol without treating it as certification', async () => {
      const fake = join(root, 'protocol');
      const payload = JSON.stringify({
        filesystem_uuid: '11111111-1111-4111-8111-111111111111',
        directory_handle_type: 1,
        directory_handle_hex: 'aabb',
        marker_hex: '7b7d',
      });
      await writeFile(fake, `#!/bin/sh\nprintf '%s' '${payload}'\n`);
      await chmod(fake, 0o700);
      const observer = new LinuxPhysicalStorageObserver(fake);
      await expect(observer.observe('originals', root)).resolves.toMatchObject({
        identity: {
          filesystem_uuid: '11111111-1111-4111-8111-111111111111',
          directory_handle_type: 1,
          directory_handle_hex: 'aabb',
        },
        markerBytes: Buffer.from('{}'),
      });
      await expect(observer.observeIdentity('originals', root)).rejects.toThrow(
        'Physical identity observation unavailable',
      );
    });

    it('bounds a stalled helper and returns only a generic failure', async () => {
      const fake = join(root, 'stalled');
      await writeFile(fake, '#!/bin/sh\nexec sleep 10\n');
      await chmod(fake, 0o700);
      const observer = new LinuxPhysicalStorageObserver(fake);
      await expect(observer.observeIdentity('originals', root)).rejects.toThrow(
        'Physical identity observation unavailable',
      );
    }, 5000);
  },
);
