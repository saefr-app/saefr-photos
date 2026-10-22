import { randomBytes } from 'node:crypto';

import * as argon2 from 'argon2';
import { Injectable } from '@nestjs/common';

export class ArgonCapacityError extends Error {}

export class PasswordPolicyError extends Error {
  constructor() {
    super('Password does not meet the local policy.');
  }
}

// Revisit these parameters after benchmarking each deployment class. Rejecting
// other PHC costs also prevents a damaged database row from demanding unbounded work.
export const PASSWORD_COST = {
  type: argon2.argon2id,
  version: 0x13,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

// This is a hash of a random, discarded value, never a usable account secret.
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,p=1,t=3$XRBTyKFua30pDX2QBYWpKQ$vDwjmViYZOQE8aht4ZllhIamyz3yKmCdWhxbYVMbwSM';

// A deliberately small local denylist, not a substitute for breached-password
// screening. Comparison is case-insensitive; the actual password is not changed.
const COMMON_PASSWORDS = new Set([
  'password123456789',
  '123456789012345',
  'qwertyuiopasdfgh',
  'letmein123456789',
  'correcthorsebatterystaple',
]);

const ENCODED_HASH =
  /^\$argon2id\$v=19\$m=65536,p=1,t=3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

function validUnicode(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

export function validateNewPassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !validUnicode(value))
    throw new PasswordPolicyError();
  const length = Array.from(value).length;
  if (
    length < 15 ||
    length > 128 ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    COMMON_PASSWORDS.has(value.toLowerCase())
  )
    throw new PasswordPolicyError();
}

function validCandidate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    validUnicode(value) &&
    Buffer.byteLength(value, 'utf8') <= 512
  );
}

@Injectable()
export class PasswordService {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= 2) {
      if (this.waiting.length >= 16) throw new ArgonCapacityError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  async hash(password: unknown): Promise<string> {
    validateNewPassword(password);
    const bytes = Buffer.from(password, 'utf8');
    try {
      return await this.bounded(() =>
        argon2.hash(bytes, {
          ...PASSWORD_COST,
          salt: randomBytes(16),
        }),
      );
    } finally {
      bytes.fill(0);
    }
  }

  async verify(password: unknown, encodedHash: unknown): Promise<boolean> {
    if (!validCandidate(password) || typeof encodedHash !== 'string')
      return false;
    if (!ENCODED_HASH.test(encodedHash)) return false;
    const bytes = Buffer.from(password, 'utf8');
    try {
      return await this.bounded(() => argon2.verify(encodedHash, bytes));
    } catch (error) {
      if (error instanceof ArgonCapacityError) throw error;
      // Malformed or damaged stored hashes never escape as native errors.
      return false;
    } finally {
      bytes.fill(0);
    }
  }

  async verifyOrDummy(
    password: unknown,
    encodedHash?: string,
  ): Promise<boolean> {
    if (!validCandidate(password)) return false;
    const actual = encodedHash !== undefined && ENCODED_HASH.test(encodedHash);
    const matched = await this.verify(
      password,
      actual ? encodedHash : DUMMY_HASH,
    );
    return actual && matched;
  }
}
