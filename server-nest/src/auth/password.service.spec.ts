import { describe, expect, it } from 'vitest';

import {
  ArgonCapacityError,
  PasswordPolicyError,
  PasswordService,
  validateNewPassword,
} from './password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with independent Argon2id salts and verifies exact Unicode bytes', async () => {
    const password = '  distinct 🔒密码 choice 2026  ';
    const first = await service.hash(password);
    const second = await service.hash(password);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await service.verify(password, first)).toBe(true);
    expect(await service.verify(password.trim(), first)).toBe(false);
    expect(await service.verify('  distinct 🔒密码 choice 2027  ', first)).toBe(
      false,
    );
  }, 20_000);

  it.each([
    undefined,
    42,
    '',
    'short',
    'a'.repeat(129),
    '🧩'.repeat(129),
    '🧩'.repeat(128) + 'a',
    'password123456789',
    'PASSWORD123456789',
    'bad\ud800surrogate long',
  ])('rejects invalid new password without storing it: %s', async (value) => {
    expect(() => validateNewPassword(value)).toThrow(PasswordPolicyError);
    await expect(service.hash(value)).rejects.toThrow(PasswordPolicyError);
  });

  it('allows Unicode and spaces without normalization', () => {
    expect(() =>
      validateNewPassword('e\u0301 with spaces and 🧩'),
    ).not.toThrow();
  });

  it('rejects malformed or resource-expensive stored hashes safely', async () => {
    for (const encoded of [
      undefined,
      'plaintext',
      '$argon2i$v=19$m=65536,p=1,t=3$abc$abc',
      '$argon2id$v=19$m=4294967295,p=1,t=100$abc$abc',
      '$argon2id$v=19$m=65536,p=1,t=3$aaaaaaaaaaaaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]) {
      expect(await service.verify('correct password long', encoded)).toBe(
        false,
      );
    }
    expect(await service.verify('\ud800', 'plaintext')).toBe(false);
  });

  it('performs dummy work for unknown and malformed account hashes', async () => {
    expect(await service.verifyOrDummy('unknown account password')).toBe(false);
    expect(
      await service.verifyOrDummy('unknown account password', 'damaged'),
    ).toBe(false);
    const encoded = await service.hash('known account password');
    expect(await service.verifyOrDummy('known account password', encoded)).toBe(
      true,
    );
  }, 20_000);

  it('bounds queued Argon work rather than accepting unlimited requests', async () => {
    const busy = new PasswordService();
    const results = await Promise.allSettled(
      Array.from({ length: 19 }, () =>
        busy.hash('parallel isolated secure phrase'),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(18);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.any(ArgonCapacityError),
      }),
    ]);
  }, 30_000);

  it('reports verification capacity exhaustion instead of an invalid password', async () => {
    const busy = new PasswordService();
    const encoded = await busy.hash('parallel isolated secure phrase');
    const results = await Promise.allSettled(
      Array.from({ length: 19 }, () =>
        busy.verify('parallel isolated secure phrase', encoded),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(18);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.any(ArgonCapacityError),
      }),
    ]);
  }, 30_000);
});
