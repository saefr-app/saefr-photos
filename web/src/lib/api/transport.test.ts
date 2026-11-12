import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	changePassword,
	login,
	logout,
	revokeSession
} from './auth';
import { clearCsrfToken, setCsrfToken } from './csrf';
import { ApiRequestError } from './errors';

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

function callOf(fetchMock: ReturnType<typeof vi.fn>) {
	const call = fetchMock.mock.calls[0];
	if (!call) throw new Error('fetch was not called');
	const [url, init] = call as [string, RequestInit];
	return {
		url,
		init,
		headers: init.headers as Record<string, string>
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	clearCsrfToken();
});

describe('login transport', () => {
	it('sends the exact login contract with same-origin credentials and no CSRF/Cookie header', async () => {
		const fetchMock = mockFetch(
			jsonResponse({
				user: {
					id: 'u1',
					username: 'sahil',
					role: 'admin',
					passwordChangeRequired: false
				},
				session: { id: 's1', expiresAt: '2026-12-12T00:00:00.000Z' },
				csrfToken: 'csrf-from-login'
			})
		);

		const result = await login('sahil', 'correct horse battery');

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe('/api/v1/auth/login');
		expect(init.method).toBe('POST');
		expect(init.credentials).toBe('same-origin');
		expect(init.cache).toBe('no-store');
		expect(init.body).toBe(
			JSON.stringify({ username: 'sahil', password: 'correct horse battery' })
		);
		expect(headers['Content-Type']).toBe('application/json');
		expect(headers['X-Saefr-Login']).toBe('1');
		expect(headers['X-CSRF-Token']).toBeUndefined();
		expect(headers.Cookie).toBeUndefined();
		expect(result.csrfToken).toBe('csrf-from-login');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('empty mutations', () => {
	it('logout sends no body or content type and attaches CSRF when present', async () => {
		setCsrfToken('csrf-in-memory');
		const fetchMock = mockFetch(new Response(null, { status: 204 }));

		await expect(logout()).resolves.toBeUndefined();

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe('/api/v1/auth/logout');
		expect(init.method).toBe('POST');
		expect(init.body).toBeUndefined();
		expect(headers['Content-Type']).toBeUndefined();
		expect(headers['X-CSRF-Token']).toBe('csrf-in-memory');
	});

	it('revokeSession sends DELETE with no body and an encoded id', async () => {
		setCsrfToken('csrf-2');
		const fetchMock = mockFetch(new Response(null, { status: 204 }));

		await expect(revokeSession('abc/def')).resolves.toBeUndefined();

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe('/api/v1/auth/sessions/abc%2Fdef');
		expect(init.method).toBe('DELETE');
		expect(init.body).toBeUndefined();
		expect(headers['X-CSRF-Token']).toBe('csrf-2');
	});

	it('changePassword sends exact JSON and CSRF, and returns undefined on 204', async () => {
		setCsrfToken('csrf-3');
		const fetchMock = mockFetch(new Response(null, { status: 204 }));

		await expect(
			changePassword('current-pass', 'new-password')
		).resolves.toBeUndefined();

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe('/api/v1/auth/password');
		expect(init.body).toBe(
			JSON.stringify({
				currentPassword: 'current-pass',
				newPassword: 'new-password'
			})
		);
		expect(headers['Content-Type']).toBe('application/json');
		expect(headers['X-CSRF-Token']).toBe('csrf-3');
	});
});

describe('status mapping and failure behaviour', () => {
	it('maps 401 to a safe session-ended message', async () => {
		mockFetch(
			jsonResponse(
				{ statusCode: 401, message: 'INTERNAL SESSION DETAIL', error: 'Unauthorized' },
				401
			)
		);

		const error = await login('user', 'pass').catch((caught) => caught);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(401);
		expect(error.api.message).toContain('session has ended');
		expect(error.api.message).not.toContain('INTERNAL');
	});

	it('maps 403 to a permission message', async () => {
		mockFetch(jsonResponse({ statusCode: 403 }, 403));
		const error = await login('user', 'pass').catch((caught) => caught);
		expect(error.api.status).toBe(403);
		expect(error.api.message).toContain('permission');
	});

	it('maps 429 and preserves Retry-After', async () => {
		mockFetch(
			jsonResponse({ statusCode: 429 }, 429, { 'retry-after': '900' })
		);
		const error = await login('user', 'pass').catch((caught) => caught);
		expect(error.api.status).toBe(429);
		expect(error.api.retryAfterSeconds).toBe(900);
		expect(error.api.message).toContain('900 seconds');
	});

	it('marks 503 as temporarily unavailable', async () => {
		mockFetch(jsonResponse({ statusCode: 503 }, 503));
		const error = await login('user', 'pass').catch((caught) => caught);
		expect(error.api.status).toBe(503);
		expect(error.api.kind).toBe('unavailable');
		expect(error.api.message).toContain('temporarily unavailable');
	});

	it('maps a network failure to status 0 without retrying', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
		vi.stubGlobal('fetch', fetchMock);

		const error = await login('user', 'pass').catch((caught) => caught);
		expect(error.api.status).toBe(0);
		expect(error.api.kind).toBe('network');
		expect(error.api.message).toContain('Could not reach Saefr');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
