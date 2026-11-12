import { describe, expect, it } from 'vitest';

import type { ApiError } from '#lib/api';
import {
	createUserError,
	disableUserError,
	validateAddUser,
	validateCurrentPassword,
	validateInitialPassword,
	validateUsername
} from './users';

function apiError(status: number, message = 'Safe client message.'): ApiError {
	return { status, message, kind: status === 503 ? 'unavailable' : 'http' };
}

describe('username validation', () => {
	it('accepts the backend canonical shape and trims surrounding spaces', () => {
		expect(validateUsername('sahil')).toBe('');
		expect(validateUsername(' New.User ')).toBe('');
		expect(validateUsername('A_1-b')).toBe('');
		expect(validateUsername('a'.repeat(64))).toBe('');
	});

	it('rejects empty, too short, leading-symbol, spaces and non-ASCII values', () => {
		expect(validateUsername('')).toBe('Enter a username.');
		expect(validateUsername('   ')).toBe('Enter a username.');
		expect(validateUsername('ab')).toContain('3–64');
		expect(validateUsername('-abc')).toContain('starting with a letter or number');
		expect(validateUsername('has space')).toContain('3–64');
		expect(validateUsername('sahil!')).toContain('3–64');
		expect(validateUsername('sahilé')).toContain('Use only');
		expect(validateUsername('a'.repeat(65))).toContain('3–64');
	});
});

describe('password validation', () => {
	it('enforces the shared client password policy', () => {
		expect(validateInitialPassword('short')).toContain('15');
		expect(validateInitialPassword('a'.repeat(15))).toBe('');
		expect(validateInitialPassword('a'.repeat(129))).toContain('128');
	});

	it('requires a current password without applying the new-password policy', () => {
		expect(validateCurrentPassword('')).toBe('Enter your current password.');
		expect(validateCurrentPassword('x')).toBe('');
	});
});

describe('add-user form validation', () => {
	it('reports every invalid field at once', () => {
		expect(validateAddUser('', 'short', '')).toEqual({
			username: 'Enter a username.',
			initialPassword: expect.stringContaining('15'),
			currentPassword: 'Enter your current password.'
		});
	});

	it('returns no errors for a valid form', () => {
		expect(validateAddUser('new-user', 'a'.repeat(15), 'admin-pass')).toEqual({
			username: '',
			initialPassword: '',
			currentPassword: ''
		});
	});
});

describe('admin error copy', () => {
	it('explains a username conflict on create', () => {
		expect(createUserError(apiError(409))).toContain('already in use');
	});

	it('explains invalid input, restricted access and unavailable service on create', () => {
		expect(createUserError(apiError(400))).toContain('username and password');
		expect(createUserError(apiError(403))).toContain('permission');
		expect(createUserError(apiError(503))).toContain('temporarily unavailable');
	});

	it('preserves rate-limit copy with its retry window', () => {
		expect(
			createUserError(apiError(429, 'Too many attempts. Try again in 900 seconds.'))
		).toContain('900 seconds');
	});

	it('explains cannot-disable conflicts and missing accounts', () => {
		expect(disableUserError(apiError(409))).toContain('cannot be disabled');
		expect(disableUserError(apiError(409))).toContain('last active administrator');
		expect(disableUserError(apiError(404))).toContain('no longer exists');
	});

	it('explains invalid input, restricted access and unavailable service on disable', () => {
		expect(disableUserError(apiError(400))).toContain('current password');
		expect(disableUserError(apiError(403))).toContain('permission');
		expect(disableUserError(apiError(503))).toContain('temporarily unavailable');
	});
});
