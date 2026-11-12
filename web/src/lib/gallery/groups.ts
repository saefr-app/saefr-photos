import type { AssetPageItem } from '../api/types';
import { formatMonthLabel } from './format';

export interface AssetMonthGroup {
	/** Stable `YYYY-MM` key (local time), or `unknown` for invalid dates. */
	key: string;
	label: string;
	items: AssetPageItem[];
}

function monthKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Groups in first-seen month order while preserving each group's source order.
 * Non-contiguous items from the same month join their original group.
 */
export function groupAssetsByMonth(
	items: readonly AssetPageItem[]
): AssetMonthGroup[] {
	const groups: AssetMonthGroup[] = [];
	const byKey = new Map<string, AssetMonthGroup>();

	for (const item of items) {
		const date = new Date(item.created_at);
		const key = Number.isNaN(date.getTime()) ? 'unknown' : monthKey(date);
		let group = byKey.get(key);
		if (!group) {
			group = {
				key,
				label: formatMonthLabel(item.created_at),
				items: []
			};
			byKey.set(key, group);
			groups.push(group);
		}
		group.items.push(item);
	}

	return groups;
}

/** Appends server-ordered items and drops duplicate ids on both sides. */
export function mergeAssetPage(
	existing: readonly AssetPageItem[],
	incoming: readonly AssetPageItem[]
): AssetPageItem[] {
	const seen = new Set(existing.map((item) => item.id));
	const merged = [...existing];

	for (const item of incoming) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		merged.push(item);
	}

	return merged;
}
