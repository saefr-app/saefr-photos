import { describe, expect, it } from 'vitest';

import { nextCursorAfterPage } from './cursor';

describe('nextCursorAfterPage', () => {
	it('keeps a fresh server cursor', () => {
		expect(nextCursorAfterPage(null, 'p2')).toBe('p2');
		expect(nextCursorAfterPage('p1', 'p2')).toBe('p2');
	});

	it('ends paging when the server returns no cursor', () => {
		expect(nextCursorAfterPage(null, null)).toBeNull();
		expect(nextCursorAfterPage('p1', null)).toBeNull();
	});

	it('treats an echoed cursor as the end instead of looping', () => {
		expect(nextCursorAfterPage('p1', 'p1')).toBeNull();
	});
});
