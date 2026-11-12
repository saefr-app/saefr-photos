import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearCsrfToken, setCsrfToken } from './csrf';
import { ApiRequestError } from './errors';
import type { AdminUser } from './types';
import { createUser, disableUser, listUsers } from './users';

function jsonResponse(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {}
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}

function mockFetch(response: Response) {
	const fetchMock = vi.fn().mockResolvedValue(response);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

function callOf(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
	const call = fetchMock.mock.calls[index];
	if (!call) throw new Error('fetch was not called');
	const [url, init] = call as [string, RequestInit];
	return {
		url,
		init,
		headers: init.headers as Record<string, string>
	};
}

function userRecord(id: string, overrides: Partial<AdminUser> = {}): AdminUser {
	return {
		id,
		username: `user-${id}`,
		role: 'user',
		status: 'active',
		passwordChangeRequired: true,
		createdAt: '2026-10-15T22:42:24.313Z',
		updatedAt: '2026-10-15T22:42:24.313Z',
		...overrides
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	clearCsrfToken();
});

describe('listUsers', () => {
	it('requests limit/offset and reads the backend envelope in server order', async () => {
		const fetchMock = mockFetch(
			jsonResponse({
				items: [userRecord('b'), userRecord('a')],
				limit: 50,
				offset: 0
			})
		);

		const users = await listUsers();

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe('/api/v1/users?limit=50&offset=0');
		expect(init.method).toBe('GET');
		expect(init.credentials).toBe('same-origin');
		expect(init.cache).toBe('no-store');
		expect(init.body).toBeUndefined();
		expect(headers['X-CSRF-Token']).toBeUndefined();
		expect(headers.Cookie).toBeUndefined();
		expect(users.map((user) => user.id)).toEqual(['b', 'a']);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('forwards a non-zero offset and accepts a bare array response', async () => {
		const fetchMock = mockFetch(jsonResponse([userRecord('c')]));

		const users = await listUsers({ limit: 25, offset: 50 });

		const { url } = callOf(fetchMock);
		expect(url).toBe('/api/v1/users?limit=25&offset=50');
		expect(users).toEqual([userRecord('c')]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects an unexpected payload without retrying', async () => {
		const fetchMock = mockFetch(jsonResponse({ unexpected: true }));

		await expect(listUsers()).rejects.toThrow('Unexpected user list response');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maps 403 to safe permission copy without leaking backend text', async () => {
		const fetchMock = mockFetch(
			jsonResponse(
				{ statusCode: 403, message: 'INTERNAL ROLE DETAIL', error: 'Forbidden' },
				403
			)
		);

		const error = await listUsers().catch((caught) => caught);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(403);
		expect(error.api.message).toContain('permission');
		expect(error.api.message).not.toContain('INTERNAL');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maps 401 to a safe session-ended error without retrying', async () => {
		const fetchMock = mockFetch(
			jsonResponse(
				{ statusCode: 401, message: 'SESSION INTERNAL', error: 'Unauthorized' },
				401
			)
		);

		const error = await listUsers().catch((caught) => caught);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(401);
		expect(error.api.message).toContain('session has ended');
		expect(error.api.message).not.toContain('SESSION INTERNAL');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('createUser', () => {
	it('sends the exact create body, CSRF header and same-origin/no-store rules', async () => {
		setCsrfToken('csrf-create');
		const created = userRecord('new', { username: 'sahil' });
		const fetchMock = mockFetch(jsonResponse(created));

		const result = await createUser('sahil', 'initial-password-1', 'admin-pass-1');

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe('/api/v1/users');
		expect(init.method).toBe('POST');
		expect(init.credentials).toBe('same-origin');
		expect(init.cache).toBe('no-store');
		expect(init.body).toBe(
			JSON.stringify({
				username: 'sahil',
				initialPassword: 'initial-password-1',
				currentPassword: 'admin-pass-1'
			})
		);
		expect(Object.keys(JSON.parse(init.body as string))).toEqual([
			'username',
			'initialPassword',
			'currentPassword'
		]);
		expect(headers['Content-Type']).toBe('application/json');
		expect(headers['X-CSRF-Token']).toBe('csrf-create');
		expect(headers.Cookie).toBeUndefined();
		expect(result).toEqual(created);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maps a username conflict to a safe 409 without retrying', async () => {
		const fetchMock = mockFetch(
			jsonResponse(
				{ statusCode: 409, message: 'INTERNAL CONFLICT DETAIL', error: 'Conflict' },
				409
			)
		);

		const error = await createUser('sahil', 'initial-password-1', 'admin-pass-1').catch(
			(caught) => caught
		);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(409);
		expect(error.api.message).toContain('conflicts');
		expect(error.api.message).not.toContain('INTERNAL');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('preserves Retry-After on 429', async () => {
		const fetchMock = mockFetch(
			jsonResponse({ statusCode: 429 }, 429, { 'retry-after': '900' })
		);

		const error = await createUser('sahil', 'initial-password-1', 'admin-pass-1').catch(
			(caught) => caught
		);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(429);
		expect(error.api.retryAfterSeconds).toBe(900);
		expect(error.api.message).toContain('900 seconds');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('marks 503 as temporarily unavailable', async () => {
		const fetchMock = mockFetch(jsonResponse({ statusCode: 503 }, 503));

		const error = await createUser('sahil', 'initial-password-1', 'admin-pass-1').catch(
			(caught) => caught
		);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(503);
		expect(error.api.kind).toBe('unavailable');
		expect(error.api.message).toContain('temporarily unavailable');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('disableUser', () => {
	it('sends the exact disable body to the encoded id and treats 204 as success', async () => {
		setCsrfToken('csrf-disable');
		const fetchMock = mockFetch(new Response(null, { status: 204 }));

		await expect(disableUser('abc/def', 'admin-pass-1')).resolves.toBeUndefined();

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe('/api/v1/users/abc%2Fdef/disable');
		expect(init.method).toBe('POST');
		expect(init.credentials).toBe('same-origin');
		expect(init.cache).toBe('no-store');
		expect(init.body).toBe(JSON.stringify({ currentPassword: 'admin-pass-1' }));
		expect(Object.keys(JSON.parse(init.body as string))).toEqual([
			'currentPassword'
		]);
		expect(headers['Content-Type']).toBe('application/json');
		expect(headers['X-CSRF-Token']).toBe('csrf-disable');
		expect(headers.Cookie).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maps 401 to a safe session-ended error without retrying', async () => {
		const fetchMock = mockFetch(
			jsonResponse(
				{ statusCode: 401, message: 'REAUTH INTERNAL', error: 'Unauthorized' },
				401
			)
		);

		const error = await disableUser('user-1', 'wrong-password').catch(
			(caught) => caught
		);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(401);
		expect(error.api.message).toContain('session has ended');
		expect(error.api.message).not.toContain('REAUTH INTERNAL');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maps a cannot-disable conflict to a safe 409', async () => {
		const fetchMock = mockFetch(
			jsonResponse(
				{ statusCode: 409, message: 'INTERNAL LAST ADMIN', error: 'Conflict' },
				409
			)
		);

		const error = await disableUser('admin-1', 'admin-pass-1').catch(
			(caught) => caught
		);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(409);
		expect(error.api.message).toContain('conflicts');
		expect(error.api.message).not.toContain('INTERNAL');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maps 400 and 503 to safe transport errors', async () => {
		const badRequest = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ statusCode: 400 }, 400))
			.mockResolvedValueOnce(jsonResponse({ statusCode: 503 }, 503));
		vi.stubGlobal('fetch', badRequest);

		const first = await disableUser('user-1', 'admin-pass-1').catch(
			(caught) => caught
		);
		const second = await disableUser('user-1', 'admin-pass-1').catch(
			(caught) => caught
		);

		expect(first.api.status).toBe(400);
		expect(first.api.message).toContain('could not be completed');
		expect(second.api.status).toBe(503);
		expect(second.api.kind).toBe('unavailable');
		expect(badRequest).toHaveBeenCalledTimes(2);
	});
});

describe('credential handling', () => {
	it('never writes passwords or CSRF state to browser storage', async () => {
		const storage = {
			getItem: vi.fn(),
			setItem: vi.fn(),
			removeItem: vi.fn(),
			clear: vi.fn()
		};
		vi.stubGlobal('localStorage', storage);
		vi.stubGlobal('sessionStorage', storage);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(userRecord('new')))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetchMock);

		await createUser('new-user', 'initial-password-1', 'admin-pass-1');
		await disableUser('new', 'admin-pass-1');

		expect(storage.setItem).not.toHaveBeenCalled();
		expect(storage.getItem).not.toHaveBeenCalled();
		expect(storage.removeItem).not.toHaveBeenCalled();
		expect(storage.clear).not.toHaveBeenCalled();

		const [createCall, disableCall] = fetchMock.mock.calls as [
			string,
			RequestInit
		][];
		expect(createCall[0]).not.toContain('admin-pass-1');
		expect(disableCall[0]).not.toContain('admin-pass-1');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
