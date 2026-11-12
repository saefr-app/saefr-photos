import { describe, expect, it } from 'vitest';

import { nextCursorAfterPage } from '../gallery/cursor';
import { mergeAssetPage } from '../gallery/groups';
import type { TrashPageItem } from '../api/types';

function item(id: string, trashed_at: string): TrashPageItem {
	return {
		id,
		filename: `${id}.jpg`,
		mime_type: 'image/jpeg',
		size: 1024,
		created_at: '2026-10-15T22:42:24.313Z',
		lifecycle_version: '5',
		trashed_at
	};
}

describe('Trash pagination merge', () => {
	it('dedupes ids, preserves server order and keeps trashed_at', () => {
		const first = item('a', '2026-10-26T10:10:00.123456Z');
		const duplicate = item('a', '2026-10-26T10:10:00.123456Z');
		const second = item('b', '2026-10-25T09:00:00.123456Z');

		const merged = mergeAssetPage([first], [duplicate, second]);

		expect(merged.map((entry) => entry.id)).toEqual(['a', 'b']);
		expect(merged[0]).toBe(first);
		expect(merged[1].trashed_at).toBe('2026-10-25T09:00:00.123456Z');
	});

	it('stops when the server echoes the requested cursor', () => {
		expect(nextCursorAfterPage('cursor-1', 'cursor-1')).toBeNull();
		expect(nextCursorAfterPage('cursor-1', 'cursor-2')).toBe('cursor-2');
		expect(nextCursorAfterPage(null, 'cursor-2')).toBe('cursor-2');
	});
});
