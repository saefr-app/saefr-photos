/**
 * Client mirror of the backend's password and return-path rules.
 * The backend remains authoritative: the common-password denylist and every
 * final decision live in `server/src/auth/password.service.ts`.
 */

export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_MAX_BYTES = 512;

export const DEFAULT_NEXT_PATH = '/photos';

const encoder = new TextEncoder();

export function passwordByteLength(value: string): number {
	return encoder.encode(value).length;
}

/** Returns safe copy describing the first violation, or `null` when valid. */
export function validateNewPassword(value: string): string | null {
	const length = Array.from(value).length;
	if (length < PASSWORD_MIN_LENGTH)
		return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
	if (length > PASSWORD_MAX_LENGTH)
		return `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`;
	if (passwordByteLength(value) > PASSWORD_MAX_BYTES)
		return `Use a shorter password (${PASSWORD_MAX_BYTES} bytes maximum).`;
	return null;
}

/**
 * Only same-site absolute paths may be used as a post-login destination.
 * Rejects protocol-relative hosts, schemes, backslash tricks, control
 * characters and the login route itself (which would loop).
 */
export function safeNextPath(raw: string | null | undefined): string {
	if (!raw) return DEFAULT_NEXT_PATH;
	const value = raw.trim();
	if (!value.startsWith('/') || value.startsWith('//')) return DEFAULT_NEXT_PATH;
	if (value.includes('\\')) return DEFAULT_NEXT_PATH;
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return DEFAULT_NEXT_PATH;
	}
	const path = value.split(/[?#]/, 1)[0];
	if (path === '/login' || path === '/login/') return DEFAULT_NEXT_PATH;
	return value;
}
