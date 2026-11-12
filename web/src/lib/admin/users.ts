import type { ApiError } from '#lib/api';
import { validateNewPassword } from '#lib/auth/policy';

export interface AddUserErrors {
	username: string;
	initialPassword: string;
	currentPassword: string;
}

/**
 * Mirrors the backend's canonical username rules for early feedback. The
 * server still trims, lowercases and rejects; this only prevents avoidable
 * round trips and never widens what the backend accepts.
 */
export function validateUsername(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return 'Enter a username.';
	if (/[^\x20-\x7e]/.test(trimmed))
		return 'Use only letters, numbers, dots, hyphens and underscores.';
	const canonical = trimmed.toLowerCase();
	if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(canonical))
		return 'Use 3–64 characters, starting with a letter or number.';
	return '';
}

export function validateInitialPassword(value: string): string {
	return validateNewPassword(value) ?? '';
}

export function validateCurrentPassword(value: string): string {
	return value ? '' : 'Enter your current password.';
}

export function validateAddUser(
	username: string,
	initialPassword: string,
	currentPassword: string
): AddUserErrors {
	return {
		username: validateUsername(username),
		initialPassword: validateInitialPassword(initialPassword),
		currentPassword: validateCurrentPassword(currentPassword)
	};
}

export function validateDisablePassword(value: string): string {
	return validateCurrentPassword(value);
}

/**
 * Operation-specific, client-authored copy. The backend envelope is never
 * rendered; these messages stay safe even if its wording changes.
 */
export function createUserError(error: ApiError): string {
	switch (error.status) {
		case 400:
			return 'Check the username and password rules, then try again.';
		case 403:
			return 'Your account does not have permission to create users.';
		case 409:
			return 'That username is already in use. Choose another.';
		case 429:
			return error.message;
		case 503:
			return 'User management is temporarily unavailable. Try again in a moment.';
		default:
			return error.message;
	}
}

export function disableUserError(error: ApiError): string {
	switch (error.status) {
		case 400:
			return 'Check your current password and try again.';
		case 403:
			return 'Your account does not have permission to disable users.';
		case 404:
			return 'That account no longer exists. Refresh the list and try again.';
		case 409:
			return 'This account cannot be disabled. The last active administrator and protected accounts cannot be disabled.';
		case 429:
			return error.message;
		case 503:
			return 'User management is temporarily unavailable. Try again in a moment.';
		default:
			return error.message;
	}
}
