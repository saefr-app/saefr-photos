import { describe, expect, it } from 'vitest';

import type { AssetPageItem } from '../api/types';
import { neighborAssets } from './navigation';

function item(id: string): AssetPageItem {
	return {
		id,
		filename: `${id}.jpg`,
		mime_type: 'image/jpeg',
		size: 1024,
		created_at: '2026-10-15T22:42:24.313Z',
		lifecycle_version: '0'
	};
}

const items = [item('a'), item('b'), item('c')];

describe('neighborAssets', () => {
	it('returns previous and next in server order', () => {
		const neighbors = neighborAssets(items, 'b');

		expect(neighbors).not.toBeNull();
		expect(neighbors?.index).toBe(1);
		expect(neighbors?.previous?.id).toBe('a');
		expect(neighbors?.next?.id).toBe('c');
	});

	it('has no previous at the first position', () => {
		const neighbors = neighborAssets(items, 'a');

		expect(neighbors?.index).toBe(0);
		expect(neighbors?.previous).toBeNull();
		expect(neighbors?.next?.id).toBe('b');
	});

	it('has no next at the last position', () => {
		const neighbors = neighborAssets(items, 'c');

		expect(neighbors?.index).toBe(2);
		expect(neighbors?.previous?.id).toBe('b');
		expect(neighbors?.next).toBeNull();
	});

	it('has neither neighbour for a single loaded item', () => {
		const neighbors = neighborAssets([item('only')], 'only');

		expect(neighbors?.previous).toBeNull();
		expect(neighbors?.next).toBeNull();
	});

	it('invents nothing when the current id is not loaded', () => {
		expect(neighborAssets(items, 'missing')).toBeNull();
		expect(neighborAssets([], 'missing')).toBeNull();
	});
});
