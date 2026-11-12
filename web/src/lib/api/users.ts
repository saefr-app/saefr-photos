import { request } from './transport';
import type { AdminUser, AdminUserPage } from './types';

export const DEFAULT_USERS_LIMIT = 50;

export interface ListUsersOptions {
	/** Backend accepts 1–100. Defaults to 50. */
	limit?: number;
	/** Nonnegative integer offset into the server-ordered list. */
	offset?: number;
}

function isAdminUserPage(value: unknown): value is AdminUserPage {
	return (
		typeof value === 'object' &&
		value !== null &&
		Array.isArray((value as { items?: unknown }).items)
	);
}

/**
 * The backend returns `{items, limit, offset}` with no total count. A bare
 * array is also accepted so the boundary stays tolerant of the documented
 * shape without fabricating pagination state.
 */
function usersFrom(payload: unknown): AdminUser[] {
	if (Array.isArray(payload)) return payload as AdminUser[];
	if (isAdminUserPage(payload)) return payload.items;
	throw new Error('Unexpected user list response');
}

/**
 * Cursorless administrator listing. Order is server-owned (username, then id);
 * no client sorting or total count is applied.
 */
export async function listUsers(
	options: ListUsersOptions = {}
): Promise<AdminUser[]> {
	const limit = options.limit ?? DEFAULT_USERS_LIMIT;
	const offset = options.offset ?? 0;
	const query = new URLSearchParams({
		limit: String(limit),
		offset: String(offset)
	});
	const payload = await request<unknown>(`/api/v1/users?${query.toString()}`);
	return usersFrom(payload);
}

/** Creates an ordinary account. Role escalation is not part of the contract. */
export function createUser(
	username: string,
	initialPassword: string,
	currentPassword: string
): Promise<AdminUser> {
	return request<AdminUser>('/api/v1/users', {
		method: 'POST',
		body: { username, initialPassword, currentPassword }
	});
}

/** Disables an account and revokes its sessions. The backend answers 204. */
export function disableUser(
	id: string,
	currentPassword: string
): Promise<void> {
	return request<void>(
		`/api/v1/users/${encodeURIComponent(id)}/disable`,
		{
			method: 'POST',
			body: { currentPassword }
		}
	);
}
