import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  parsePermitCommand,
  permitLocation,
} from './recovery-permit-config.js';
import { RecoveryPermitService } from './recovery-permit.service.js';
import {
  encodePermit,
  MAX_GENERATION,
  nextGeneration,
  pairingFingerprint,
  parseApproval,
  parsePermit,
  RecoveryPermitError,
  type RecoveryPermit,
} from './recovery-permit.js';

const binding = {
  singleton: true,
  storage_id: '11111111-1111-4111-8111-111111111111',
  originals_binding_id: '22222222-2222-4222-8222-222222222222',
  thumbnails_binding_id: '33333333-3333-4333-8333-333333333333',
  storage_layout_version: 1,
};
const fingerprint = pairingFingerprint(binding);
const permit: RecoveryPermit = {
  version: 1,
  armed: true,
  generation: '2',
  pairing_sha256: fingerprint,
};

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');

describe('independent recovery permit contract', () => {
  it.each(['/synthetic/media', '/synthetic/media/', '/synthetic/media//'])(
    'canonicalizes excluded directory %s without weakening target validation',
    (root) => {
      const env = {
        RECOVERY_PERMIT_PATH: '/control/permit.json',
        RECOVERY_PERMIT_RESTORE_ROOTS: JSON.stringify([root]),
        RECOVERY_PERMIT_OPERATOR_UID: '0',
        RECOVERY_PERMIT_READER_GID: '1001',
      };
      expect(permitLocation(env).restoreRoots).toEqual(['/synthetic/media']);
      for (const invalid of [
        '/synthetic/media/.',
        '/synthetic/media/../other',
        '/synthetic//media',
      ]) {
        expect(() =>
          permitLocation({
            ...env,
            RECOVERY_PERMIT_RESTORE_ROOTS: JSON.stringify([invalid]),
          }),
        ).toThrow(RecoveryPermitError);
      }
      expect(
        permitLocation({ ...env, RECOVERY_PERMIT_RESTORE_ROOTS: '["/"]' })
          .restoreRoots,
      ).toEqual(['/']);
      expect(() =>
        permitLocation({
          ...env,
          RECOVERY_PERMIT_PATH: '/control/permit.json/',
        }),
      ).toThrow(RecoveryPermitError);
    },
  );
  it('round-trips the canonical versioned record and bigint generations exactly', () => {
    expect(parsePermit(encodePermit(permit))).toEqual(permit);
    expect(
      parsePermit(
        encodePermit({ ...permit, generation: String(MAX_GENERATION) }),
      ).generation,
    ).toBe(String(MAX_GENERATION));
    expect(nextGeneration('9007199254740993')).toBe('9007199254740994');
    expect(() => nextGeneration(String(MAX_GENERATION))).toThrow(
      RecoveryPermitError,
    );
  });

  it.each([
    '0',
    '-1',
    '01',
    '1.0',
    '1e3',
    '9223372036854775808',
    '',
    ' 1',
    null,
    2,
  ])('rejects generation %s', (generation) => {
    expect(() => parsePermit(bytes({ ...permit, generation }))).toThrow(
      RecoveryPermitError,
    );
  });

  it.each([
    Buffer.alloc(1025, 32),
    Buffer.alloc(0),
    Buffer.from('{'),
    Buffer.from([0xff]),
    Buffer.from('\ufeff' + encodePermit(permit).toString()),
    bytes({ ...permit, armed: 'true' }),
    bytes({ ...permit, version: 2 }),
    bytes({ ...permit, injected: true }),
    bytes({ ...permit, pairing_sha256: 'private/path' }),
    bytes({ ...permit, pairing_sha256: [fingerprint] }),
    Buffer.from(
      encodePermit(permit)
        .toString()
        .replace('"armed":true', '"armed":false,"armed":true'),
    ),
  ])('rejects malformed, duplicate or oversized records', (input) => {
    expect(() => parsePermit(input)).toThrow(RecoveryPermitError);
  });

  it('binds schema version and every logical role identity without depending on object order', () => {
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      pairingFingerprint({
        ...binding,
        originals_binding_id: binding.thumbnails_binding_id,
        thumbnails_binding_id: binding.originals_binding_id,
      }),
    ).not.toBe(fingerprint);
    expect(
      pairingFingerprint(
        Object.fromEntries(Object.entries(binding).reverse()) as typeof binding,
      ),
    ).toBe(fingerprint);
    expect(() =>
      pairingFingerprint({ ...binding, storage_layout_version: 2 }),
    ).toThrow();
    expect(() =>
      pairingFingerprint({
        ...binding,
        thumbnails_binding_id: binding.originals_binding_id,
      }),
    ).toThrow();
  });

  it('requires canonical protected approval bound to the exact action, generation and evidence digest', () => {
    const approval = {
      version: 1,
      action: 'arm',
      expected_generation: '1',
      pairing_sha256: fingerprint,
      operator_reference: 'review-17',
      fencing_record_sha256: 'a'.repeat(64),
      reconciliation_record_sha256: 'b'.repeat(64),
      backup_record_sha256: 'c'.repeat(64),
      first_provisioning: false,
    };
    const input = bytes(approval);
    const digest = createHash('sha256').update(input).digest('hex');
    expect(parseApproval(input, digest)).toEqual(approval);
    expect(() => parseApproval(input, '0'.repeat(64))).toThrow();
    for (const change of [
      { expected_generation: '0' },
      { first_provisioning: true },
      { fencing_record_sha256: '' },
      { operator_reference: '/private/evidence' },
      { ignored: 'yes' },
    ]) {
      const bad = bytes({ ...approval, ...change });
      expect(() =>
        parseApproval(bad, createHash('sha256').update(bad).digest('hex')),
      ).toThrow();
    }
  });

  it('requires explicit operator settings and exact CLI flags; never falls back to POSTGRES_*', () => {
    expect(() => permitLocation({ POSTGRES_HOST: 'production' })).toThrow();
    const location = permitLocation({
      RECOVERY_PERMIT_PATH: '/control/permit.json',
      RECOVERY_PERMIT_RESTORE_ROOTS: '["/media","/database"]',
      RECOVERY_PERMIT_OPERATOR_UID: '0',
      RECOVERY_PERMIT_READER_GID: '1001',
    });
    expect(
      parsePermitCommand(
        [
          'disarm',
          '--confirm-permit=/control/permit.json',
          '--expected-generation=1',
        ],
        location,
      ),
    ).toEqual({ action: 'disarm', expected: '1' });
    expect(
      parsePermitCommand(
        [
          'arm',
          '--confirm-permit=/control/permit.json',
          '--expected-generation=1',
          '--approval=/control/evidence.json',
          `--approval-sha256=${'a'.repeat(64)}`,
        ],
        location,
      ),
    ).toEqual({
      action: 'arm',
      expected: '1',
      evidence: '/control/evidence.json',
      digest: 'a'.repeat(64),
    });
    expect(() =>
      parsePermitCommand(
        [
          'arm',
          '--confirm-permit=/control/permit.json',
          '--expected-generation=1',
          '--confirmed=yes',
        ],
        location,
      ),
    ).toThrow();
    expect(() =>
      parsePermitCommand(['status', '--confirm-permit=/other'], location),
    ).toThrow();
    expect(() =>
      parsePermitCommand(
        [
          'status',
          '--confirm-permit=/control/permit.json',
          '--confirm-permit=/control/permit.json',
        ],
        location,
      ),
    ).toThrow();
  });
});

describe('fresh recovery permit decisions without executor composition', () => {
  it('revalidates after restart and on every call, then rejects superseded generations', async () => {
    let current = permit;
    const reader = { readRuntime: vi.fn(async () => current) };
    const probe = {
      verify: vi.fn(async () => ({ fingerprint, recordedGeneration: '0' })),
    };
    for (let restart = 0; restart < 2; restart++) {
      const service = new RecoveryPermitService(reader, probe);
      expect(await service.check('2')).toEqual({
        allowed: true,
        generation: '2',
      });
      expect(await service.check('1')).toEqual({
        allowed: false,
        reason: 'permit_changed',
      });
    }
    expect(probe.verify).toHaveBeenCalledTimes(2);
    current = { ...permit, armed: false, generation: '3' };
    expect(await new RecoveryPermitService(reader, probe).check()).toEqual({
      allowed: false,
      reason: 'permit_disarmed',
    });
  });

  it.each([
    'permit_unavailable',
    'permit_untrusted',
    'permit_invalid',
    'permit_busy',
  ] as const)('blocks %s before database or execution work', async (code) => {
    const probe = { verify: vi.fn() };
    const reader = {
      readRuntime: async (): Promise<RecoveryPermit> => {
        throw new RecoveryPermitError(code);
      },
    };
    expect(await new RecoveryPermitService(reader, probe).check()).toEqual({
      allowed: false,
      reason: code,
    });
    expect(probe.verify).not.toHaveBeenCalled();
  });

  it('rejects changed permit during pairing validation, identity mismatch, and recorded generation rollback', async () => {
    let current = permit;
    const reader = { readRuntime: async () => current };
    const probe = {
      verify: async () => {
        current = { ...permit, armed: false, generation: '3' };
        return { fingerprint, recordedGeneration: '0' };
      },
    };
    expect(await new RecoveryPermitService(reader, probe).check()).toEqual({
      allowed: false,
      reason: 'permit_changed',
    });
    current = permit;
    expect(
      await new RecoveryPermitService(reader, {
        verify: async () => ({
          fingerprint: 'f'.repeat(64),
          recordedGeneration: '0',
        }),
      }).check(),
    ).toEqual({ allowed: false, reason: 'pairing_mismatch' });
    expect(
      await new RecoveryPermitService(reader, {
        verify: async () => ({ fingerprint, recordedGeneration: '3' }),
      }).check(),
    ).toEqual({ allowed: false, reason: 'permit_changed' });
  });

  it('sanitizes failures and never invokes a fake executor while blocked', async () => {
    const service = new RecoveryPermitService(
      { readRuntime: async () => permit },
      {
        verify: async () => {
          throw new Error('postgres://secret /private/photo');
        },
      },
    );
    const execute = vi.fn();
    const decision = await service.check();
    if (decision.allowed) execute();
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(decision)).not.toMatch(/postgres|secret|private/);
    expect(decision.allowed).toBe(false);
  });
});
