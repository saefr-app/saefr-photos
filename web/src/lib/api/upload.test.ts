import { afterEach, describe, expect, it, vi } from 'vitest';

import { uploadAsset } from './assets';
import { clearCsrfToken, setCsrfToken } from './csrf';
import { ApiRequestError } from './errors';
import type { Asset } from './types';

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

function uploadedAsset(): Asset {
	return {
		id: 'asset-1',
		filename: 'photo.jpg',
		mime_type: 'image/jpeg',
		size: 3,
		created_at: '2026-10-15T22:42:24.313Z'
	};
}

function photo(name = 'photo.jpg', type = 'image/jpeg'): File {
	return new File([new Uint8Array([1, 2, 3])], name, {
		type,
		lastModified: 1_700_000_000_000
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	clearCsrfToken();
});

describe('uploadAsset multipart boundary', () => {
	it('sends one POST with exactly one `file` part, CSRF, same-origin and no manual content type', async () => {
		setCsrfToken('csrf-upload');
		const fetchMock = mockFetch(jsonResponse(uploadedAsset(), 201));
		const file = photo();

		const result = await uploadAsset(file);

		const { url, init, headers } = callOf(fetchMock);
		expect(url).toBe('/api/v1/assets/upload');
		expect(init.method).toBe('POST');
		expect(init.credentials).toBe('same-origin');
		expect(init.cache).toBe('no-store');
		expect(init.body).toBeInstanceOf(FormData);

		const form = init.body as FormData;
		expect(Array.from(form.keys())).toEqual(['file']);
		expect(form.getAll('file')).toHaveLength(1);
		const sent = form.get('file') as File;
		expect(sent).toBeInstanceOf(File);
		expect(sent.name).toBe('photo.jpg');
		expect(sent.type).toBe('image/jpeg');
		expect(sent.size).toBe(3);

		// The browser supplies the multipart boundary; a manual header would break it.
		expect(headers['Content-Type']).toBeUndefined();
		expect(headers['X-CSRF-Token']).toBe('csrf-upload');
		expect(headers.Cookie).toBeUndefined();
		expect(result).toEqual(uploadedAsset());
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maps 201 to a confirmed asset and never retries', async () => {
		const fetchMock = mockFetch(jsonResponse(uploadedAsset(), 201));

		await expect(uploadAsset(photo())).resolves.toMatchObject({
			id: 'asset-1',
			filename: 'photo.jpg'
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('treats a malformed 201 body as an uncertain network outcome', async () => {
		const fetchMock = mockFetch(jsonResponse({ id: 42 }, 201));

		const error = await uploadAsset(photo()).catch((caught) => caught);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(0);
		expect(error.api.kind).toBe('network');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('uploadAsset status mapping', () => {
	it('maps 413 to the 20 MiB file-size message', async () => {
		mockFetch(jsonResponse({ statusCode: 413 }, 413));

		const error = await uploadAsset(photo()).catch((caught) => caught);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(413);
		expect(error.api.message).toContain('20 MiB');
	});

	it('maps 415 to the unsupported-type message', async () => {
		mockFetch(jsonResponse({ statusCode: 415 }, 415));

		const error = await uploadAsset(photo()).catch((caught) => caught);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(415);
		expect(error.api.message).toContain('not supported');
	});

	it('maps 401 to a safe session-ended error', async () => {
		mockFetch(
			jsonResponse(
				{
					statusCode: 401,
					message: 'INTERNAL SESSION DETAIL',
					error: 'Unauthorized'
				},
				401
			)
		);

		const error = await uploadAsset(photo()).catch((caught) => caught);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(401);
		expect(error.api.message).toContain('session has ended');
		expect(error.api.message).not.toContain('INTERNAL');
	});

	it('maps 503 to temporarily unavailable', async () => {
		mockFetch(jsonResponse({ statusCode: 503 }, 503));

		const error = await uploadAsset(photo()).catch((caught) => caught);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(503);
		expect(error.api.kind).toBe('unavailable');
		expect(error.api.message).toContain('temporarily unavailable');
	});

	it('maps a disconnect to status 0 without retrying', async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValue(new TypeError('network down'));
		vi.stubGlobal('fetch', fetchMock);

		const error = await uploadAsset(photo()).catch((caught) => caught);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error.api.status).toBe(0);
		expect(error.api.kind).toBe('network');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
