import { describe, expect, it } from 'vitest';

import { formatDeletionReason, isCompleted } from './format';

describe('formatDeletionReason', () => {
	it('maps known safe codes to fixed copy', () => {
		expect(formatDeletionReason('storage_unavailable')).toBe(
			'Storage was temporarily unavailable.'
		);
		expect(formatDeletionReason('permission_denied')).toBe(
			'The storage location denied access.'
		);
		expect(formatDeletionReason('unknown_outcome')).toBe(
			'The storage outcome could not be confirmed.'
		);
	});

	it('never echoes an unknown raw code', () => {
		const message = formatDeletionReason('internal_path_C:/secret');
		expect(message).toBe('The deletion could not be completed by storage.');
		expect(message).not.toContain('secret');
	});

	it('reports a missing reason honestly', () => {
		expect(formatDeletionReason(null)).toBe('No storage reason was reported.');
	});
});

describe('isCompleted', () => {
	it('treats only the completed status as finished', () => {
		expect(isCompleted({ status: 'completed' })).toBe(true);
		expect(isCompleted({ status: 'pending' })).toBe(false);
	});
});
