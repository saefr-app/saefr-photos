import { describe, expect, it } from 'vitest';

import { applyRetryOutcome, mergeReceipts } from './store-helpers';

function receipt(
	asset_id: string,
	status: 'pending' | 'completed' = 'pending'
) {
	return {
		asset_id,
		status,
		requested_at: '2026-10-26T10:15:00.123456Z',
		completed_at: status === 'completed' ? '2026-10-26T10:16:00Z' : null,
		last_error_code: status === 'completed' ? null : 'storage_unavailable'
	};
}

describe('mergeReceipts', () => {
	it('appends pages in server order and dedupes on both sides', () => {
		const existing = [receipt('a'), receipt('b')];
		const incoming = [receipt('b'), receipt('c')];

		const merged = mergeReceipts(existing, incoming);

		expect(merged.map((item) => item.asset_id)).toEqual(['a', 'b', 'c']);
		expect(existing).toHaveLength(2);
	});

	it('drops malformed duplicate groups without reordering', () => {
		const merged = mergeReceipts(
			[receipt('a'), receipt('b')],
			[receipt('a'), receipt('a'), receipt('b')]
		);
		expect(merged.map((item) => item.asset_id)).toEqual(['a', 'b']);
	});
});

describe('applyRetryOutcome', () => {
	it('removes a receipt when the retry returns 200 completed', () => {
		const items = [receipt('a'), receipt('b')];

		const next = applyRetryOutcome(items, receipt('a', 'completed'), 200);

		expect(next.map((item) => item.asset_id)).toEqual(['b']);
	});

	it('keeps a pending receipt in place on 202', () => {
		const items = [receipt('a'), receipt('b')];
		const updated = receipt('a');

		const next = applyRetryOutcome(items, updated, 202);

		expect(next.map((item) => item.asset_id)).toEqual(['a', 'b']);
		expect(next[0]).toBe(updated);
	});

	it('removes a completed receipt even if the status is not 200', () => {
		const next = applyRetryOutcome(
			[receipt('a'), receipt('b')],
			receipt('a', 'completed'),
			202
		);
		expect(next.map((item) => item.asset_id)).toEqual(['b']);
	});

	it('does not mutate the input list', () => {
		const items = [receipt('a')];
		applyRetryOutcome(items, receipt('a', 'completed'), 200);
		expect(items).toHaveLength(1);
	});
});
