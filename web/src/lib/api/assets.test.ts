import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	assetOriginalPath,
	assetThumbnailPath,
	fetchAssetOriginal,
	getAsset,
	listAssets
} from './assets';
import { clearCsrfToken, setCsrfToken } from './csrf';
import { ApiRequestError } from './errors';
import type { AssetPageItem } from './types';

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
		headers: init.headers as Record<string, string> | undefined
	};
}

function pageItem(id: string): AssetPageItem {
	return {
		id,
		filename: `${id}.jpg`,
		mime_type: 'image/jpeg',
		size: 1024,
		created_at: '2026-10-15T22:42:24.313Z',
		lifecycle_version: '0'
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	clearCsrfToken();
});

describe('listAssets', () => {
	it('requests the owner page with no query and preserves server order', async () => {
		const fetchMock = mockFetch(
			jsonResponse({
				items: [pageItem('b'), pageItem('a')],
				next_cursor: 'cursor-2'
			})
		);

		const page = await listAssets();

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe('/api/v1/assets');
		expect(init.method).toBe('GET');
		expect(init.credentials).toBe('same-origin');
		expect(init.cache).toBe('no-store');
		expect(init.body).toBeUndefined();
		expect(headers?.['X-CSRF-Token']).toBeUndefined();
		expect(headers?.Cookie).toBeUndefined();
		expect(page.items.map((item) => item.id)).toEqual(['b', 'a']);
		expect(page.next_cursor).toBe('cursor-2');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('serializes limit and an opaque cursor, omitting null cursors', async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(jsonResponse({ items: [], next_cursor: null }))
			);
		vi.stubGlobal('fetch', fetchMock);

		await listAssets({ limit: 50 });
		await listAssets({ cursor: 'cursor-abc' });
		await listAssets({ limit: 25, cursor: null });

		const calls = fetchMock.mock.calls as [string, RequestInit][];
		expect(calls.map(([url]) => url)).toEqual([
			'/api/v1/assets?limit=50',
			'/api/v1/assets?cursor=cursor-abc',
			'/api/v1/assets?limit=25'
		]);
	});

	it('query-encodes reserved cursor characters exactly once', async () => {
		const fetchMock = mockFetch(
			jsonResponse({ items: [], next_cursor: null })
		);

		await listAssets({ limit: 10, cursor: 'a/b+c==&d?%' });

		const { url } = callOf(fetchMock);
		expect(url).toBe(
			'/api/v1/assets?limit=10&cursor=a%2Fb%2Bc%3D%3D%26d%3F%25'
		);
	});
});

describe('asset paths and metadata', () => {
	it('encodes the asset id in every path segment', () => {
		expect(assetThumbnailPath('a/b?c')).toBe(
			'/api/v1/assets/a%2Fb%3Fc/thumbnail'
		);
		expect(assetOriginalPath('a/b?c')).toBe(
			'/api/v1/assets/a%2Fb%3Fc/original'
		);
	});

	it('gets one asset through the encoded id path', async () => {
		const fetchMock = mockFetch(jsonResponse(pageItem('asset-1')));

		const asset = await getAsset('abc/def?x y');

		const { url, init } = callOf(fetchMock);
		expect(url).toBe('/api/v1/assets/abc%2Fdef%3Fx%20y');
		expect(init.method).toBe('GET');
		expect(init.credentials).toBe('same-origin');
		expect(init.cache).toBe('no-store');
		expect(asset.id).toBe('asset-1');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('fetchAssetOriginal', () => {
	it('resolves a Blob from a GET with same-origin/no-store and no CSRF', async () => {
		setCsrfToken('must-not-be-sent');
		const fetchMock = mockFetch(
			new Response(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: { 'content-type': 'image/jpeg' }
			})
		);

		const blob = await fetchAssetOriginal('asset/1');

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe('/api/v1/assets/asset%2F1/original');
		expect(init.method).toBe('GET');
		expect(init.credentials).toBe('same-origin');
		expect(init.cache).toBe('no-store');
		expect(init.body).toBeUndefined();
		expect(headers?.['X-CSRF-Token']).toBeUndefined();
		expect(headers?.Cookie).toBeUndefined();
		expect(blob).toBeInstanceOf(Blob);
		expect(blob.size).toBe(3);
		expect(blob.type).toBe('image/jpeg');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maps 401 to a safe session-ended error without retrying', async () => {
		const fetchMock = mockFetch(
			jsonResponse(
				{
					statusCode: 401,
					message: 'INTERNAL SESSION DETAIL',
					error: 'Unauthorized'
				},
				401
			)
		);

		const error = await fetchAssetOriginal('asset-1').catch(
			(caught) => caught
		);

		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(401);
		expect(error.api.message).toContain('session has ended');
		expect(error.api.message).not.toContain('INTERNAL');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('marks 503 as temporarily unavailable', async () => {
		const fetchMock = mockFetch(jsonResponse({ statusCode: 503 }, 503));

		const error = await fetchAssetOriginal('asset-1').catch(
			(caught) => caught
		);

		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(503);
		expect(error.api.kind).toBe('unavailable');
		expect(error.api.message).toContain('temporarily unavailable');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maps a network rejection to status 0 with exactly one fetch call', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
		vi.stubGlobal('fetch', fetchMock);

		const error = await fetchAssetOriginal('asset-1').catch(
			(caught) => caught
		);

		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(0);
		expect(error.api.kind).toBe('network');
		expect(error.api.message).toContain('Could not reach Saefr');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
