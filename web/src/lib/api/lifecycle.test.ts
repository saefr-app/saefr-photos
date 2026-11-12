import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	assetTrashThumbnailPath,
	getAssetWithEtag,
	getDeletion,
	lifecycleEtag,
	listDeletions,
	listTrash,
	parseLifecycleEtag,
	permanentlyDeleteAsset,
	restoreAsset,
	retryDeletion,
	trashAsset
} from './assets';
import { clearCsrfToken, setCsrfToken } from './csrf';
import { ApiRequestError } from './errors';
import type { TrashPageItem } from './types';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

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
		headers: (init.headers ?? {}) as Record<string, string>
	};
}

function transition(version: string, state: 'active' | 'trashed') {
	return {
		id: ID,
		state,
		trashed_at: state === 'trashed' ? '2026-10-26T10:10:00.123456Z' : null,
		lifecycle_version: version
	};
}

function receipt(status: 'pending' | 'completed') {
	return {
		asset_id: ID,
		status,
		requested_at: '2026-10-26T10:15:00.123456Z',
		completed_at: status === 'completed' ? '2026-10-26T10:16:00Z' : null,
		last_error_code: status === 'completed' ? null : 'storage_unavailable'
	};
}

function trashItem(id: string): TrashPageItem {
	return {
		id,
		filename: `${id}.jpg`,
		mime_type: 'image/jpeg',
		size: 1024,
		created_at: '2026-10-15T22:42:24.313Z',
		lifecycle_version: '5',
		trashed_at: '2026-10-26T10:10:00.123456Z'
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	clearCsrfToken();
});

describe('lifecycle strong ETag', () => {
	it('builds the exact quoted validator without a weak prefix', () => {
		const etag = lifecycleEtag(ID, '5');
		expect(etag).toBe(`"asset-lifecycle:${ID}:5"`);
		expect(etag.startsWith('"')).toBe(true);
		expect(etag.endsWith('"')).toBe(true);
		expect(etag.startsWith('W/')).toBe(false);
		expect(parseLifecycleEtag(etag)).toBe('5');
	});

	it('preserves int8-sized decimal versions and rejects non-strong values', () => {
		const large = '9223372036854775807';
		expect(parseLifecycleEtag(lifecycleEtag(ID, large))).toBe(large);
		expect(parseLifecycleEtag(`W/${lifecycleEtag(ID, '5')}`)).toBeNull();
		expect(parseLifecycleEtag(`"asset-lifecycle:${ID}:05"`)).toBeNull();
		expect(parseLifecycleEtag(`"asset-lifecycle:${ID}:5", "other"`)).toBeNull();
		expect(parseLifecycleEtag(null)).toBeNull();
		expect(parseLifecycleEtag(undefined)).toBeNull();
	});
});

describe('Trash page', () => {
	it('requests the trash collection with cursor and preserves trash fields', async () => {
		const fetchMock = mockFetch(
			jsonResponse({ items: [trashItem(ID)], next_cursor: 'next' })
		);

		const page = await listTrash({ limit: 50, cursor: 'a/b+c==' });

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe(
			'/api/v1/assets/trash?limit=50&cursor=a%2Fb%2Bc%3D%3D'
		);
		expect(init.method).toBe('GET');
		expect(init.body).toBeUndefined();
		expect(headers['X-CSRF-Token']).toBeUndefined();
		expect(page.items[0].trashed_at).toBe('2026-10-26T10:10:00.123456Z');
		expect(page.items[0].lifecycle_version).toBe('5');
		expect(page.next_cursor).toBe('next');
	});

	it('builds an encoded owner-only Trash thumbnail path', () => {
		expect(assetTrashThumbnailPath('a/b?c')).toBe(
			'/api/v1/assets/trash/a%2Fb%3Fc/thumbnail'
		);
	});
});

describe('asset metadata ETag', () => {
	it('captures the strong response ETag for a direct-link viewer', async () => {
		const etag = lifecycleEtag(ID, '9');
		const fetchMock = mockFetch(
			jsonResponse(
				{ id: ID, filename: 'x.jpg', mime_type: 'image/jpeg', size: 1, created_at: '2026-10-15T22:42:24.313Z' },
				200,
				{ ETag: etag }
			)
		);

		const result = await getAssetWithEtag(ID);

		expect(callOf(fetchMock).url).toBe(`/api/v1/assets/${ID}`);
		expect(result.etag).toBe(etag);
		expect(parseLifecycleEtag(result.etag)).toBe('9');
		expect(result.asset.id).toBe(ID);
	});
});

describe('empty-body lifecycle mutations', () => {
	it('trashes with an exact If-Match, no body, no content type and CSRF', async () => {
		setCsrfToken('csrf-lifecycle');
		const nextEtag = lifecycleEtag(ID, '6');
		const fetchMock = mockFetch(
			jsonResponse(transition('6', 'trashed'), 200, { ETag: nextEtag })
		);

		const result = await trashAsset(ID, lifecycleEtag(ID, '5'));

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe(`/api/v1/assets/${ID}/trash`);
		expect(init.method).toBe('POST');
		expect(init.body).toBeUndefined();
		expect(init.credentials).toBe('same-origin');
		expect(init.cache).toBe('no-store');
		expect(headers['Content-Type']).toBeUndefined();
		expect(headers['If-Match']).toBe(lifecycleEtag(ID, '5'));
		expect(headers['X-CSRF-Token']).toBe('csrf-lifecycle');
		expect(result.status).toBe(200);
		expect(result.transition.state).toBe('trashed');
		expect(result.transition.lifecycle_version).toBe('6');
		expect(result.etag).toBe(nextEtag);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('restores with an exact If-Match and returns the fresh active version', async () => {
		const fetchMock = mockFetch(
			jsonResponse(transition('7', 'active'), 200, {
				ETag: lifecycleEtag(ID, '7')
			})
		);

		const result = await restoreAsset(ID, lifecycleEtag(ID, '6'));

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe(`/api/v1/assets/${ID}/restore`);
		expect(init.body).toBeUndefined();
		expect(headers['Content-Type']).toBeUndefined();
		expect(headers['If-Match']).toBe(lifecycleEtag(ID, '6'));
		expect(result.transition.state).toBe('active');
		expect(result.transition.trashed_at).toBeNull();
		expect(result.transition.lifecycle_version).toBe('7');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('fails locally on a missing or weak validator without calling fetch', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		for (const bad of ['', `W/${lifecycleEtag(ID, '5')}`, 'asset-lifecycle:5']) {
			const error = await restoreAsset(ID, bad).catch((caught) => caught);
			expect(error).toBeInstanceOf(ApiRequestError);
			expect(error.api.status).toBe(428);
			expect(error.api.message).toContain('current photo version');
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('lifecycle status and error paths', () => {
	it('maps a server 412 without retrying or forcing the transition', async () => {
		const fetchMock = mockFetch(jsonResponse({ statusCode: 412 }, 412));

		const error = await trashAsset(ID, lifecycleEtag(ID, '5')).catch(
			(caught) => caught
		);

		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(412);
		expect(error.api.message).toContain('changed since');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('treats a server 428 as an implementation defect', async () => {
		const fetchMock = mockFetch(jsonResponse({ statusCode: 428 }, 428));

		const error = await restoreAsset(ID, lifecycleEtag(ID, '5')).catch(
			(caught) => caught
		);

		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(428);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maps 503 as unavailable with exactly one request', async () => {
		const fetchMock = mockFetch(jsonResponse({ statusCode: 503 }, 503));

		const error = await restoreAsset(ID, lifecycleEtag(ID, '5')).catch(
			(caught) => caught
		);

		expect(error.api.status).toBe(503);
		expect(error.api.kind).toBe('unavailable');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('permanent deletion', () => {
	it('sends DELETE with empty body, strong If-Match and captures a 200 receipt', async () => {
		setCsrfToken('csrf-delete');
		const fetchMock = mockFetch(
			jsonResponse(receipt('completed'), 200, {
				Location: `/api/v1/assets/deletions/${ID}`
			})
		);

		const result = await permanentlyDeleteAsset(ID, lifecycleEtag(ID, '6'));

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe(`/api/v1/assets/${ID}`);
		expect(init.method).toBe('DELETE');
		expect(init.body).toBeUndefined();
		expect(headers['Content-Type']).toBeUndefined();
		expect(headers['If-Match']).toBe(lifecycleEtag(ID, '6'));
		expect(headers['X-CSRF-Token']).toBe('csrf-delete');
		expect(result.status).toBe(200);
		expect(result.receipt?.status).toBe('completed');
		expect(result.location).toBe(`/api/v1/assets/deletions/${ID}`);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('does not present a 202 as completed', async () => {
		const fetchMock = mockFetch(
			jsonResponse(receipt('pending'), 202, {
				Location: `/api/v1/assets/deletions/${ID}`
			})
		);

		const result = await permanentlyDeleteAsset(ID, lifecycleEtag(ID, '6'));

		expect(result.status).toBe(202);
		expect(result.receipt?.status).toBe('pending');
		expect(result.receipt?.completed_at).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('surfaces 409 and 503 without retrying', async () => {
		const conflict = mockFetch(jsonResponse({ statusCode: 409 }, 409));
		const conflictError = await permanentlyDeleteAsset(
			ID,
			lifecycleEtag(ID, '6')
		).catch((caught) => caught);
		expect(conflictError.api.status).toBe(409);
		expect(conflict).toHaveBeenCalledTimes(1);

		vi.unstubAllGlobals();
		const unavailable = mockFetch(jsonResponse({ statusCode: 503 }, 503));
		const unavailableError = await permanentlyDeleteAsset(
			ID,
			lifecycleEtag(ID, '6')
		).catch((caught) => caught);
		expect(unavailableError.api.status).toBe(503);
		expect(unavailableError.api.kind).toBe('unavailable');
		expect(unavailable).toHaveBeenCalledTimes(1);
	});

	it('treats a network failure as uncertain with exactly one request', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));
		vi.stubGlobal('fetch', fetchMock);

		const error = await permanentlyDeleteAsset(
			ID,
			lifecycleEtag(ID, '6')
		).catch((caught) => caught);

		expect(error.api.status).toBe(0);
		expect(error.api.kind).toBe('network');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('deletion receipts', () => {
	it('lists pending receipts with an opaque cursor', async () => {
		const fetchMock = mockFetch(
			jsonResponse({ items: [receipt('pending')], next_cursor: 'more' })
		);

		const page = await listDeletions({ limit: 50, cursor: 'abc' });

		expect(callOf(fetchMock).url).toBe(
			'/api/v1/assets/deletions?limit=50&cursor=abc'
		);
		expect(page.items[0].status).toBe('pending');
		expect(page.next_cursor).toBe('more');
	});

	it('fetches one owned receipt by encoded id', async () => {
		const fetchMock = mockFetch(jsonResponse(receipt('completed')));

		const result = await getDeletion('a/b');

		expect(callOf(fetchMock).url).toBe('/api/v1/assets/deletions/a%2Fb');
		expect(result.status).toBe('completed');
	});

	it('retries with empty body, CSRF and no If-Match', async () => {
		setCsrfToken('csrf-retry');
		const fetchMock = mockFetch(
			jsonResponse(receipt('pending'), 202, {
				Location: `/api/v1/assets/deletions/${ID}`
			})
		);

		const result = await retryDeletion(ID);

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe(`/api/v1/assets/deletions/${ID}/retry`);
		expect(init.method).toBe('POST');
		expect(init.body).toBeUndefined();
		expect(headers['Content-Type']).toBeUndefined();
		expect(headers['If-Match']).toBeUndefined();
		expect(headers['X-CSRF-Token']).toBe('csrf-retry');
		expect(result.status).toBe(202);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('returns completed on 200 and never schedules another attempt', async () => {
		const fetchMock = mockFetch(jsonResponse(receipt('completed'), 200));

		const result = await retryDeletion(OTHER_ID);

		expect(callOf(fetchMock).url).toBe(
			`/api/v1/assets/deletions/${OTHER_ID}/retry`
		);
		expect(result.status).toBe(200);
		expect(result.receipt?.status).toBe('completed');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maps a retry 503 without retrying', async () => {
		const fetchMock = mockFetch(jsonResponse({ statusCode: 503 }, 503));

		const error = await retryDeletion(ID).catch((caught) => caught);

		expect(error.api.status).toBe(503);
		expect(error.api.kind).toBe('unavailable');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
