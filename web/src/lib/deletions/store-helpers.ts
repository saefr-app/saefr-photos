export interface ReceiptIdentity {
	asset_id: string;
	status: 'pending' | 'completed';
}

/** Appends receipt pages while dropping duplicate asset ids on both sides. */
export function mergeReceipts<T extends { asset_id: string }>(
	existing: readonly T[],
	incoming: readonly T[]
): T[] {
	const seen = new Set(existing.map((receipt) => receipt.asset_id));
	const merged = [...existing];
	for (const receipt of incoming) {
		if (seen.has(receipt.asset_id)) continue;
		seen.add(receipt.asset_id);
		merged.push(receipt);
	}
	return merged;
}

/**
 * Applies an explicit retry outcome. `200` means completed, so the receipt
 * leaves the pending list; `202` (or any pending receipt) is replaced in place.
 * Nothing schedules another attempt.
 */
export function applyRetryOutcome<T extends ReceiptIdentity>(
	items: readonly T[],
	receipt: T,
	status: number
): T[] {
	if (status === 200 || receipt.status === 'completed') {
		return items.filter((item) => item.asset_id !== receipt.asset_id);
	}
	return items.map((item) =>
		item.asset_id === receipt.asset_id ? receipt : item
	);
}
