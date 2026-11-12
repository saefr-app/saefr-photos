import { randomUUID } from 'node:crypto';

export const SYNTHETIC_JOB = 'synthetic.ping.v1';
export const SYNTHETIC_SCHEDULER = 'synthetic-heartbeat-v1';

export interface SyntheticJob {
  version: 1;
  nonce: string;
}

export function syntheticJob(): SyntheticJob {
  return { version: 1, nonce: randomUUID() };
}

export function parseSyntheticJob(value: unknown): SyntheticJob {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid synthetic job');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    record.version !== 1 ||
    typeof record.nonce !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      record.nonce,
    )
  ) {
    throw new Error('Invalid synthetic job');
  }
  return { version: 1, nonce: record.nonce };
}
