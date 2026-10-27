import { describe, expect, it } from 'vitest';

import {
  encodeCursor,
  lifecycleEtag,
  nextVersion,
  parseIfMatch,
  parsePageQuery,
} from './asset-lifecycle-contract.js';

const owner = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const position = {
  v: 1 as const,
  owner,
  collection: 'active' as const,
  timestamp: '2026-10-26T10:00:00.123456Z',
  id,
};

describe('M12 pagination and lifecycle wire contracts', () => {
  it('defaults to 50, accepts 1 through 100, and round-trips a canonical cursor', () => {
    expect(parsePageQuery('/api/v1/assets', owner, 'active')).toEqual({
      limit: 50,
      cursor: null,
    });
    expect(
      parsePageQuery('/api/v1/assets?limit=1', owner, 'active').limit,
    ).toBe(1);
    expect(
      parsePageQuery('/api/v1/assets?limit=100', owner, 'active').limit,
    ).toBe(100);
    const cursor = encodeCursor(position);
    expect(
      parsePageQuery(`/api/v1/assets?cursor=${cursor}`, owner, 'active'),
    ).toEqual({
      limit: 50,
      cursor: position,
    });
  });

  it.each([
    '?limit=0',
    '?limit=101',
    '?limit=01',
    '?limit=-1',
    '?limit=1.5',
    '?limit=1&limit=2',
    '?cursor=',
    '?owner=someone',
    '?limit[]=5',
  ])('rejects invalid query %s', (query) => {
    expect(() =>
      parsePageQuery(`/api/v1/assets${query}`, owner, 'active'),
    ).toThrow();
  });

  it('rejects noncanonical, oversized, cross-owner, cross-collection and malformed positions', () => {
    const cases = [
      'a'.repeat(1025),
      `${encodeCursor(position)}=`,
      encodeCursor({ ...position, owner: id }),
      encodeCursor({ ...position, collection: 'trash' }),
      encodeCursor({ ...position, timestamp: '2026-02-30T10:00:00.123456Z' }),
      encodeCursor({ ...position, timestamp: '2026-10-26T10:00:00.123Z' }),
      encodeCursor({ ...position, id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }),
      Buffer.from('{"v":1,"v":1,"owner":"x"}', 'utf8').toString('base64url'),
      Buffer.from(
        JSON.stringify({ ...position, extra: 'bad' }),
        'utf8',
      ).toString('base64url'),
    ];
    for (const cursor of cases) {
      expect(() =>
        parsePageQuery(`/api/v1/assets?cursor=${cursor}`, owner, 'active'),
      ).toThrow();
    }
  });

  it('requires one exact strong ETag and preserves int8 versions', () => {
    const tag = lifecycleEtag(id, '9007199254740993');
    expect(parseIfMatch(tag, id)).toBe('9007199254740993');
    for (const value of [
      undefined,
      '*',
      `W/${tag}`,
      `${tag},${tag}`,
      [tag, tag],
      `"asset-lifecycle:${owner}:1"`,
    ]) {
      expect(() => parseIfMatch(value, id)).toThrow();
    }
    expect(nextVersion('9007199254740993')).toBe('9007199254740994');
    expect(() => nextVersion('9223372036854775807')).toThrow();
  });
});
