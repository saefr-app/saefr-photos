import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	clearCsrfToken,
	getCsrfToken,
	setCsrfToken
} from './csrf';

afterEach(() => {
	vi.unstubAllGlobals();
	clearCsrfToken();
});

describe('in-memory CSRF holder', () => {
	it('sets, reads and clears a token', () => {
		expect(getCsrfToken()).toBeNull();
		setCsrfToken('token-1');
		expect(getCsrfToken()).toBe('token-1');
		clearCsrfToken();
		expect(getCsrfToken()).toBeNull();
	});

	it('never touches localStorage or sessionStorage', () => {
		const local = {
			getItem: vi.fn(),
			setItem: vi.fn(),
			removeItem: vi.fn()
		};
		const session = {
			getItem: vi.fn(),
			setItem: vi.fn(),
			removeItem: vi.fn()
		};
		vi.stubGlobal('localStorage', local);
		vi.stubGlobal('sessionStorage', session);

		setCsrfToken('token-2');
		expect(getCsrfToken()).toBe('token-2');
		clearCsrfToken();

		expect(local.getItem).not.toHaveBeenCalled();
		expect(local.setItem).not.toHaveBeenCalled();
		expect(local.removeItem).not.toHaveBeenCalled();
		expect(session.getItem).not.toHaveBeenCalled();
		expect(session.setItem).not.toHaveBeenCalled();
		expect(session.removeItem).not.toHaveBeenCalled();
	});
});
