import type { AssetPageItem } from '../api/types';

export interface AssetNeighbors {
	/** Item at index - 1, or null at the first position. */
	previous: AssetPageItem | null;
	/** Item at index + 1, or null at the last position. */
	next: AssetPageItem | null;
	index: number;
}

/**
 * Neighbours from the currently loaded gallery context only. An id that is not
 * loaded (for example a direct link) has no invented neighbours or counts.
 */
export function neighborAssets(
	items: readonly AssetPageItem[],
	id: string
): AssetNeighbors | null {
	const index = items.findIndex((item) => item.id === id);
	if (index === -1) return null;

	return {
		previous: index > 0 ? items[index - 1] : null,
		next: index < items.length - 1 ? items[index + 1] : null,
		index
	};
}
