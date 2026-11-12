/** Safe, human copy for the backend's closed set of deletion reason codes. */
const REASONS: Readonly<Record<string, string>> = {
	storage_unavailable: 'Storage was temporarily unavailable.',
	storage_identity_mismatch: 'Storage identity could not be verified.',
	unsupported_storage: 'This storage does not support deletion completion.',
	unexpected_file: 'A file on disk did not match the expected photo.',
	permission_denied: 'The storage location denied access.',
	filesystem_error: 'A filesystem error interrupted the deletion.',
	durability_unavailable: 'Deletion durability could not be confirmed.',
	inconsistent_state: 'The deletion record was inconsistent.',
	unknown_outcome: 'The storage outcome could not be confirmed.'
};

/**
 * Maps a receipt's safe reason code to fixed copy. Unknown codes never echo
 * internal wording or raw values.
 */
export function formatDeletionReason(code: string | null): string {
	if (!code) return 'No storage reason was reported.';
	return REASONS[code] ?? 'The deletion could not be completed by storage.';
}

export function isCompleted(receipt: {
	status: 'pending' | 'completed';
}): boolean {
	return receipt.status === 'completed';
}
