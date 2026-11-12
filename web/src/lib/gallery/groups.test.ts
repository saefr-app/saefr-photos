import { describe, expect, it } from 'vitest';

import type { AssetPageItem } from '../api/types';
import { formatMonthLabel } from './format';
import { groupAssetsByMonth, mergeAssetPage } from './groups';

function localIso(
	year: number,
	monthIndex: number,
	day: number,
	hour = 12
): string {
	return new Date(year, monthIndex, day, hour).toISOString();
}

function item(id: string, createdAt: string): AssetPageItem {
	return {
		id,
		filename: `${id}.jpg`,
		mime_type: 'image/jpeg',
		size: 1024,
		created_at: createdAt,
		lifecycle_version: '0'
	};
}

describe('groupAssetsByMonth', () => {
	it('preserves source order inside and across month groups', () => {
		const octFirst = item('oct-first', localIso(2026, 9, 20));
		const nov = item('nov', localIso(2026, 10, 5));
		const octSecond = item('oct-second', localIso(2026, 9, 2));

		const groups = groupAssetsByMonth([octFirst, nov, octSecond]);

		expect(groups.map((group) => group.key)).toEqual([
			'2026-10',
			'2026-11'
		]);
		expect(groups[0].items.map((entry) => entry.id)).toEqual([
			'oct-first',
			'oct-second'
		]);
		expect(groups[1].items.map((entry) => entry.id)).toEqual(['nov']);
		expect(groups[0].label).toBe(formatMonthLabel(octFirst.created_at));
	});

	it('merges non-contiguous items from the same month into one group', () => {
		const first = item('a', localIso(2026, 9, 20));
		const other = item('b', localIso(2026, 8, 1));
		const second = item('c', localIso(2026, 9, 2));
		const third = item('d', localIso(2026, 8, 3));

		const groups = groupAssetsByMonth([first, other, second, third]);

		expect(groups).toHaveLength(2);
		expect(groups[0].items.map((entry) => entry.id)).toEqual(['a', 'c']);
		expect(groups[1].items.map((entry) => entry.id)).toEqual(['b', 'd']);
	});

	it('groups invalid dates under an Unknown label', () => {
		const groups = groupAssetsByMonth([
			item('bad-1', 'not-a-date'),
			item('bad-2', '')
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0].key).toBe('unknown');
		expect(groups[0].label).toBe('Date added · Unknown');
		expect(groups[0].items.map((entry) => entry.id)).toEqual([
			'bad-1',
			'bad-2'
		]);
	});

	it('returns no groups for an empty page', () => {
		expect(groupAssetsByMonth([])).toEqual([]);
	});
});

describe('mergeAssetPage', () => {
	it('appends in server order and drops duplicate ids', () => {
		const existing = [item('a', localIso(2026, 9, 3)), item('b', localIso(2026, 9, 2))];
		const incoming = [
			item('b', localIso(2026, 9, 2)),
			item('c', localIso(2026, 9, 1)),
			item('a', localIso(2026, 9, 3)),
			item('d', localIso(2026, 8, 30)),
			item('d', localIso(2026, 8, 30))
		];

		const merged = mergeAssetPage(existing, incoming);

		expect(merged.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('does not mutate either input page', () => {
		const existing = [item('a', localIso(2026, 9, 3))];
		const incoming = [item('b', localIso(2026, 9, 2))];

		mergeAssetPage(existing, incoming);

		expect(existing.map((entry) => entry.id)).toEqual(['a']);
		expect(incoming.map((entry) => entry.id)).toEqual(['b']);
	});

	it('returns a copy when either side is empty', () => {
		const existing = [item('a', localIso(2026, 9, 3))];

		expect(mergeAssetPage(existing, []).map((entry) => entry.id)).toEqual([
			'a'
		]);
		expect(mergeAssetPage([], existing).map((entry) => entry.id)).toEqual([
			'a'
		]);
	});
});
