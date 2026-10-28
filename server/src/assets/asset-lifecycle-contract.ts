import { BadRequestException, HttpException } from '@nestjs/common';

export type AssetCollection = 'active' | 'trash' | 'pending-deletions';
export interface PageCursor {
  v: 1;
  owner: string;
  collection: AssetCollection;
  timestamp: string;
  id: string;
}
export interface PageRequest {
  limit: number;
  cursor: PageCursor | null;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const MAX_VERSION = 9_223_372_036_854_775_807n;

export function isCanonicalUuid(value: string): boolean {
  return UUID.test(value);
}

export function validCursorTimestamp(value: string): boolean {
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const milliseconds = `${value.slice(0, 19)}.${value.slice(20, 23)}Z`;
  const date = new Date(milliseconds);
  return !Number.isNaN(date.getTime()) && date.toISOString() === milliseconds;
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function parsePageQuery(
  rawUrl: string,
  owner: string,
  collection: AssetCollection,
): PageRequest {
  let params: URLSearchParams;
  try {
    params = new URL(rawUrl, 'http://localhost').searchParams;
  } catch {
    throw new BadRequestException('Invalid request');
  }
  for (const key of params.keys()) {
    if (
      (key !== 'limit' && key !== 'cursor') ||
      params.getAll(key).length !== 1
    )
      throw new BadRequestException('Invalid request');
  }
  const rawLimit = params.get('limit');
  if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
    throw new BadRequestException('Invalid request');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  const raw = params.get('cursor');
  if (raw === null) return { limit, cursor: null };
  if (Buffer.byteLength(raw, 'utf8') > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new BadRequestException('Invalid request');
  let decoded: string;
  let value: unknown;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== raw)
      throw new Error('Invalid encoding');
    value = JSON.parse(decoded);
  } catch {
    throw new BadRequestException('Invalid request');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5 ||
    !Object.keys(value).every((key) =>
      ['v', 'owner', 'collection', 'timestamp', 'id'].includes(key),
    )
  )
    throw new BadRequestException('Invalid request');
  const cursor = value as Record<string, unknown>;
  if (
    cursor.v !== 1 ||
    cursor.owner !== owner ||
    cursor.collection !== collection ||
    typeof cursor.timestamp !== 'string' ||
    !validCursorTimestamp(cursor.timestamp) ||
    typeof cursor.id !== 'string' ||
    !isCanonicalUuid(cursor.id) ||
    JSON.stringify(value) !== decoded
  )
    throw new BadRequestException('Invalid request');
  return { limit, cursor: value as PageCursor };
}

export function lifecycleEtag(assetId: string, version: string): string {
  return `"asset-lifecycle:${assetId}:${version}"`;
}

export function parseIfMatch(
  header: string | string[] | undefined,
  assetId: string,
): string {
  if (header === undefined)
    throw new HttpException('Lifecycle version required', 428);
  if (typeof header !== 'string')
    throw new BadRequestException('Invalid request');
  const match = /^"asset-lifecycle:([0-9a-f-]+):(0|[1-9][0-9]*)"$/.exec(header);
  if (!match || match[1] !== assetId || !isCanonicalUuid(match[1]))
    throw new BadRequestException('Invalid request');
  try {
    if (BigInt(match[2]) > MAX_VERSION) throw new Error('Version overflow');
  } catch {
    throw new BadRequestException('Invalid request');
  }
  return match[2];
}

export function nextVersion(current: string): string {
  if (BigInt(current) >= MAX_VERSION)
    throw new HttpException('Lifecycle version conflict', 412);
  return (BigInt(current) + 1n).toString();
}
