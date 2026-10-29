import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These wrappers allow real filesystem calls plus deterministic fault injection.
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: vi.fn(real.rename),
    link: vi.fn(real.link),
    open: vi.fn(real.open),
    access: vi.fn(real.access),
  };
});

import { RecoveryPermitStore } from './recovery-permit-store.js';
import { RecoveryPermitOperator } from './recovery-permit.service.js';
import { encodePermit } from './recovery-permit.js';

const fingerprint = 'a'.repeat(64);
const originalPermit = {
  version: 1 as const,
  armed: false,
  generation: '1',
  pairing_sha256: fingerprint,
};
let root: string;
let store: RecoveryPermitStore;
let path: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'saefr-permit-unit-'));
  await fs.chmod(root, 0o750);
  path = join(root, 'permit.json');
  store = new RecoveryPermitStore({
    path,
    operatorUid: process.geteuid!(),
    readerGid: process.getegid!(),
    restoreRoots: [join(root, 'media')],
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.rename).mockReset();
  vi.mocked(fs.link).mockReset();
  vi.mocked(fs.open).mockReset();
  vi.mocked(fs.access).mockReset();
  // mockReset restores these vi.fn(original) wrappers to their original implementation.
  await fs.rm(root, { recursive: true, force: true });
});

async function seed(armed = false) {
  await fs.writeFile(path, encodePermit({ ...originalPermit, armed }), {
    mode: 0o640,
  });
}
async function approval(action: 'initialize' | 'arm', expected: string) {
  const evidence = {
    version: 1,
    action,
    expected_generation: expected,
    pairing_sha256: fingerprint,
    operator_reference: 'synthetic-review',
    fencing_record_sha256: 'b'.repeat(64),
    reconciliation_record_sha256: 'c'.repeat(64),
    backup_record_sha256: 'd'.repeat(64),
    first_provisioning: action === 'initialize',
  };
  const file = join(root, 'approval.json');
  const bytes = Buffer.from(JSON.stringify(evidence) + '\n');
  await fs.writeFile(file, bytes, { mode: 0o600 });
  return { file, digest: createHash('sha256').update(bytes).digest('hex') };
}

describe('protected recovery permit filesystem and operator updates', () => {
  it('initializes disarmed, arms only with evidence, rejects stale updates, and disarms during outages', async () => {
    const probe = {
      verify: vi.fn(async () => ({ fingerprint, recordedGeneration: '0' })),
    };
    const operator = new RecoveryPermitOperator(store, probe);
    const first = await approval('initialize', '0');
    expect(
      await operator.approvedUpdate(
        'initialize',
        '0',
        first.file,
        first.digest,
      ),
    ).toEqual(originalPermit);
    expect(await fs.readdir(root)).toEqual(
      expect.arrayContaining(['approval.json', 'permit.json']),
    );
    expect((await fs.stat(path)).nlink).toBe(1);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o640);
    await expect(
      operator.approvedUpdate('initialize', '0', first.file, first.digest),
    ).rejects.toMatchObject({ code: 'permit_changed' });
    const arm = await approval('arm', '1');
    expect(
      (await operator.approvedUpdate('arm', '1', arm.file, arm.digest))
        .generation,
    ).toBe('2');
    await expect(operator.disarm('1')).rejects.toMatchObject({
      code: 'permit_changed',
    });
    probe.verify.mockRejectedValue(new Error('Database and media unavailable'));
    expect(await operator.disarm('2')).toMatchObject({
      armed: false,
      generation: '3',
    });
    expect(await store.readOperator()).toMatchObject({
      armed: false,
      generation: '3',
    });
    expect(probe.verify).toHaveBeenCalledTimes(2);
  });

  it('rejects concurrent operator commands without stealing the held lock', async () => {
    await seed();
    let release!: () => void;
    let acquired!: () => void;
    const entered = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.update('arm', '1', async () => {
      acquired();
      await hold;
      return fingerprint;
    });
    await entered;
    try {
      await expect(store.update('disarm', '1')).rejects.toMatchObject({
        code: 'permit_busy',
      });
      await expect(store.readOperator()).rejects.toMatchObject({
        code: 'permit_busy',
      });
    } finally {
      release();
    }
    expect(await first).toMatchObject({ armed: true, generation: '2' });
  });

  it('retains the durable lock after rename succeeds but its acknowledgement is lost', async () => {
    await seed();
    const real =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      await real.rename(...args);
      throw new Error('lost ack');
    });
    await expect(
      store.update('arm', '1', async () => fingerprint),
    ).rejects.toMatchObject({ code: 'publication_unknown' });
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toMatchObject({
      armed: true,
      generation: '2',
    });
    await expect(store.readOperator()).rejects.toMatchObject({
      code: 'permit_busy',
    });
    await expect(store.update('disarm', '2')).rejects.toMatchObject({
      code: 'permit_busy',
    });
  });

  it('retains the lock if directory synchronization after publication fails', async () => {
    await seed();
    const real =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await real.open(...args);
      if ((await handle.stat()).isDirectory()) {
        const sync = handle.sync.bind(handle);
        let calls = 0;
        handle.sync = async () => {
          if (++calls === 2) throw new Error('sync failed');
          await sync();
        };
      }
      return handle;
    });
    await expect(
      store.update('arm', '1', async () => fingerprint),
    ).rejects.toMatchObject({ code: 'publication_unknown' });
    await expect(store.readOperator()).rejects.toMatchObject({
      code: 'permit_busy',
    });
  });

  it('restores a blocker if lock-release directory sync fails after durable publication', async () => {
    await seed();
    const real =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await real.open(...args);
      if ((await handle.stat()).isDirectory()) {
        const sync = handle.sync.bind(handle);
        let calls = 0;
        handle.sync = async () => {
          if (++calls === 3) throw new Error('release sync failed');
          await sync();
        };
      }
      return handle;
    });
    await expect(
      store.update('arm', '1', async () => fingerprint),
    ).rejects.toMatchObject({ code: 'publication_unknown' });
    await expect(store.readOperator()).rejects.toMatchObject({
      code: 'permit_busy',
    });
  });

  it('keeps the old permit when temporary file persistence fails', async () => {
    await seed();
    const real =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await real.open(...args);
      if (String(args[0]).endsWith('.tmp'))
        handle.sync = async () => {
          throw new Error('disk full');
        };
      return handle;
    });
    await expect(
      store.update('arm', '1', async () => fingerprint),
    ).rejects.toMatchObject({ code: 'permit_unavailable' });
    expect(await store.readOperator()).toEqual(originalPermit);
  });

  it('never silently initializes missing records through read or disarm', async () => {
    await expect(store.readOperator()).rejects.toMatchObject({
      code: 'permit_unavailable',
    });
    await expect(store.update('disarm', '1')).rejects.toMatchObject({
      code: 'permit_unavailable',
    });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('rejects symlink and hard-link records and permission changes', async () => {
    const target = join(root, 'target');
    await fs.writeFile(target, encodePermit(originalPermit), { mode: 0o640 });
    await fs.symlink(target, path);
    await expect(store.readOperator()).rejects.toBeDefined();
    await fs.unlink(path);
    await fs.link(target, path);
    await expect(store.readOperator()).rejects.toMatchObject({
      code: 'permit_untrusted',
    });
    await fs.unlink(path);
    await seed();
    await fs.chmod(path, 0o660);
    await expect(store.readOperator()).rejects.toMatchObject({
      code: 'permit_untrusted',
    });
    await fs.chmod(path, 0o640);
    await fs.chmod(root, 0o770);
    await expect(store.readOperator()).rejects.toMatchObject({
      code: 'permit_untrusted',
    });
  });

  it('rejects a symlink ancestor to an otherwise readable valid permit', async () => {
    await seed();
    const child = join(root, 'real');
    await fs.mkdir(child, { mode: 0o750 });
    await fs.writeFile(
      join(child, 'permit.json'),
      encodePermit(originalPermit),
      { mode: 0o640 },
    );
    expect(
      await new RecoveryPermitStore({
        ...store.location,
        path: join(child, 'permit.json'),
      }).readOperator(),
    ).toEqual(originalPermit);
    await fs.symlink(child, join(root, 'alias'));
    await expect(
      new RecoveryPermitStore({
        ...store.location,
        path: join(root, 'alias', 'permit.json'),
      }).readOperator(),
    ).rejects.toMatchObject({ code: 'permit_unavailable' });
  });

  it.each([
    ['/synthetic/media', true],
    ['/synthetic/media/', true],
    ['/synthetic/media//', true],
    ['/synthetic/media/.', true],
    ['/synthetic/media/subdirectory', false],
    ['/synthetic/media/control', true],
    ['/synthetic/media/control/permit.json', true],
    ['/synthetic/media-other', false],
    ['/synthetic/media/../elsewhere', true],
    ['/', true],
  ] as const)(
    'checks permit and approval containment for %s (blocked=%s)',
    async (suffix, blocked) => {
      const control = join(root, 'synthetic/media/control');
      await fs.mkdir(control, { recursive: true, mode: 0o750 });
      const permitPath = join(control, 'permit.json');
      const approvalPath = join(control, 'approval.json');
      await fs.writeFile(permitPath, encodePermit(originalPermit), {
        mode: 0o640,
      });
      const evidence = Buffer.from('synthetic approval');
      await fs.writeFile(approvalPath, evidence, { mode: 0o600 });
      const location = {
        ...store.location,
        path: permitPath,
        restoreRoots: [join(root, 'elsewhere')],
      };
      const direct = new RecoveryPermitStore(location);
      expect(await direct.readOperator()).toEqual(originalPermit);
      expect(await direct.readApproval(approvalPath)).toEqual(evidence);
      // Concatenate deliberately: join/resolve would erase the spelling under test.
      const excluded = suffix === '/' ? '/' : root + suffix;
      const tested = new RecoveryPermitStore({
        ...location,
        restoreRoots: [excluded],
      });
      if (blocked) {
        await expect(tested.readOperator()).rejects.toMatchObject({
          code: 'permit_untrusted',
        });
        // Exact equality is checked separately for each filename.
        const approvalStore = new RecoveryPermitStore({
          ...location,
          restoreRoots: [excluded.replace(/permit\.json$/, 'approval.json')],
        });
        await expect(
          approvalStore.readApproval(approvalPath),
        ).rejects.toMatchObject({ code: 'approval_invalid' });
      } else {
        expect(await tested.readOperator()).toEqual(originalPermit);
        expect(await tested.readApproval(approvalPath)).toEqual(evidence);
      }
    },
  );

  it.each(['/./', '/../control/', '//'])(
    'rejects noncanonical target spelling %s',
    async (segment) => {
      const control = join(root, 'control');
      await fs.mkdir(control, { mode: 0o750 });
      await fs.writeFile(
        join(control, 'permit.json'),
        encodePermit(originalPermit),
        { mode: 0o640 },
      );
      await fs.writeFile(join(control, 'approval.json'), 'synthetic', {
        mode: 0o600,
      });
      const tested = new RecoveryPermitStore({
        ...store.location,
        path: control + segment + 'permit.json',
      });
      await expect(tested.readOperator()).rejects.toMatchObject({
        code: 'permit_untrusted',
      });
      await expect(
        tested.readApproval(control + segment + 'approval.json'),
      ).rejects.toMatchObject({ code: 'approval_invalid' });
    },
  );

  it('refuses wrong ownership and refuses runtime operating as the operator', async () => {
    await seed();
    await expect(
      new RecoveryPermitStore({
        ...store.location,
        operatorUid: process.geteuid!() + 1,
      }).readOperator(),
    ).rejects.toMatchObject({ code: 'permit_untrusted' });
    await expect(store.readRuntime()).rejects.toMatchObject({
      code: 'permit_untrusted',
    });
    const uid = process.geteuid!();
    vi.spyOn(process, 'geteuid').mockReturnValue(uid + 1);
    await expect(store.update('disarm', '1')).rejects.toMatchObject({
      code: 'permit_untrusted',
    });
    // Simulated alternate UID alone cannot bypass the real effective-write check.
    await expect(store.readRuntime()).rejects.toMatchObject({
      code: 'permit_untrusted',
    });
  });

  it('refuses stale approval, pairing drift and generation rollback without publishing', async () => {
    await seed();
    const evidence = await approval('arm', '1');
    const operator = new RecoveryPermitOperator(store, {
      verify: async () => ({ fingerprint, recordedGeneration: '10' }),
    });
    await expect(
      operator.approvedUpdate('arm', '1', evidence.file, evidence.digest),
    ).rejects.toMatchObject({ code: 'permit_changed' });
    const changed = new RecoveryPermitOperator(store, {
      verify: async () => ({
        fingerprint: 'f'.repeat(64),
        recordedGeneration: '0',
      }),
    });
    await expect(
      changed.approvedUpdate('arm', '1', evidence.file, evidence.digest),
    ).rejects.toMatchObject({ code: 'pairing_mismatch' });
    expect(await store.readOperator()).toEqual(originalPermit);
  });
});
