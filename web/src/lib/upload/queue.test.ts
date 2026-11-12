import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	MAX_UPLOAD_BYTES,
	clearCsrfToken,
	uploadAsset
} from '#lib/api';
import { UploadQueue } from './queue';

function asset(id: string) {
	return {
		id,
		filename: `${id}.jpg`,
		mime_type: 'image/jpeg' as const,
		size: 3,
		created_at: '2026-10-15T22:42:24.313Z'
	};
}

function ok(id = 'asset-1'): Response {
	return new Response(JSON.stringify(asset(id)), {
		status: 201,
		headers: { 'content-type': 'application/json' }
	});
}

function fail(status: number): Response {
	return new Response(JSON.stringify({ statusCode: status }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function photo(name = 'photo.jpg', type = 'image/jpeg'): File {
	return new File([new Uint8Array([1, 2, 3])], name, {
		type,
		lastModified: 1_700_000_000_000
	});
}

/** Drain the fetch/response microtask chain used by the queue. */
async function flush(): Promise<void> {
	for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function setup() {
	const onSuccess = vi.fn();
	const onUnauthorized = vi.fn();
	const queue = new UploadQueue({
		upload: uploadAsset,
		onSuccess,
		onUnauthorized
	});
	return { queue, onSuccess, onUnauthorized };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	clearCsrfToken();
});

describe('sequential upload ordering', () => {
	it('keeps exactly one request in flight and completes in selection order', async () => {
		const pending: Array<(response: Response) => void> = [];
		const fetchMock = vi.fn().mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					pending.push(resolve);
				})
		);
		vi.stubGlobal('fetch', fetchMock);

		const { queue, onSuccess } = setup();
		queue.addFiles([photo('one.jpg'), photo('two.jpg')]);

		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(queue.snapshot().items.map((item) => item.status)).toEqual([
			'uploading',
			'pending'
		]);

		pending.shift()?.(ok('asset-1'));
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(queue.snapshot().items.map((item) => item.status)).toEqual([
			'success',
			'uploading'
		]);

		pending.shift()?.(ok('asset-2'));
		await flush();
		expect(queue.snapshot().items.map((item) => item.status)).toEqual([
			'success',
			'success'
		]);
		expect(onSuccess.mock.calls.map(([created]) => created.id)).toEqual([
			'asset-1',
			'asset-2'
		]);
		expect(queue.snapshot().active).toBe(false);
	});
});

describe('201 confirmation and per-file failures', () => {
	it('marks 201 as confirmed success and keeps the queue closable', async () => {
		const fetchMock = vi.fn().mockResolvedValue(ok('asset-1'));
		vi.stubGlobal('fetch', fetchMock);

		const { queue, onSuccess } = setup();
		queue.addFiles([photo()]);
		await flush();

		const [item] = queue.snapshot().items;
		expect(item?.status).toBe('success');
		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(queue.canClose()).toBe(true);
		expect(queue.dismissAll()).toBe(true);
		expect(queue.snapshot().items).toEqual([]);
	});

	it.each([
		[400, 'could not be completed'],
		[413, '20 MiB'],
		[415, 'not supported']
	])(
		'continues to the next pending file after a %i rejection',
		async (status, message) => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(fail(status))
				.mockResolvedValueOnce(ok('asset-2'));
			vi.stubGlobal('fetch', fetchMock);

			const { queue, onSuccess } = setup();
			queue.addFiles([photo('bad.jpg'), photo('good.png', 'image/png')]);
			await flush();

			const items = queue.snapshot().items;
			expect(items[0]?.status).toBe('error');
			expect(items[0]?.error?.status).toBe(status);
			expect(items[0]?.error?.message).toContain(message);
			expect(items[1]?.status).toBe('success');
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(onSuccess).toHaveBeenCalledTimes(1);
			expect(queue.snapshot().blocked).toBeNull();
		}
	);
});

describe('halts that require an explicit user action', () => {
	it('expires on 401 and sends no further files', async () => {
		const fetchMock = vi.fn().mockResolvedValue(fail(401));
		vi.stubGlobal('fetch', fetchMock);

		const { queue, onUnauthorized } = setup();
		queue.addFiles([photo('one.jpg'), photo('two.jpg')]);
		await flush();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(queue.snapshot().items.map((item) => item.status)).toEqual([
			'error',
			'pending'
		]);
		expect(queue.snapshot().blocked).toBe('unauthorized');
		expect(onUnauthorized).toHaveBeenCalledTimes(1);
	});

	it('pauses on 503 and only resumes on explicit retry', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(fail(503))
			.mockResolvedValueOnce(ok('asset-2'));
		vi.stubGlobal('fetch', fetchMock);

		const { queue } = setup();
		queue.addFiles([photo('one.jpg'), photo('two.jpg')]);
		await flush();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(queue.snapshot().items[0]?.error?.kind).toBe('unavailable');
		expect(queue.snapshot().items[1]?.status).toBe('pending');
		expect(queue.snapshot().blocked).toBe('unavailable');

		queue.dismiss(queue.snapshot().items[0]?.id ?? '');
		await flush();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(queue.snapshot().items.map((item) => item.status)).toEqual([
			'success'
		]);
		expect(queue.snapshot().blocked).toBeNull();
	});

	it.each([
		[403, 'forbidden', 'permission'],
		[429, 'rate-limited', 'Too many attempts']
	])(
		'halts with safe copy after a %i response',
		async (status, block, message) => {
			const fetchMock = vi.fn().mockResolvedValue(fail(status));
			vi.stubGlobal('fetch', fetchMock);

			const { queue } = setup();
			queue.addFiles([photo('one.jpg'), photo('two.jpg')]);
			await flush();

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(queue.snapshot().blocked).toBe(block);
			expect(queue.snapshot().items[0]?.error?.message).toContain(message);
			expect(queue.snapshot().items[1]?.status).toBe('pending');
			expect(queue.snapshot().active).toBe(false);
		}
	);

	it('marks a disconnect uncertain and never auto-retries', async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValue(new TypeError('network down'));
		vi.stubGlobal('fetch', fetchMock);

		const { queue, onSuccess } = setup();
		queue.addFiles([photo('one.jpg'), photo('two.jpg')]);
		await flush();

		const items = queue.snapshot().items;
		expect(items[0]?.status).toBe('uncertain');
		expect(items[0]?.error?.status).toBe(0);
		expect(items[1]?.status).toBe('pending');
		expect(queue.snapshot().blocked).toBe('uncertain');
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Wait beyond the response microtasks: no automatic second attempt.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(onSuccess).not.toHaveBeenCalled();
		expect(queue.canClose()).toBe(false);
	});

	it('retries an uncertain upload only after the user calls retry', async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('network down'))
			.mockResolvedValueOnce(ok('asset-1'));
		vi.stubGlobal('fetch', fetchMock);

		const { queue, onSuccess } = setup();
		queue.addFiles([photo()]);
		await flush();

		const id = queue.snapshot().items[0]?.id ?? '';
		expect(queue.snapshot().items[0]?.status).toBe('uncertain');
		expect(fetchMock).toHaveBeenCalledTimes(1);

		queue.retry(id);
		await flush();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(queue.snapshot().items[0]?.status).toBe('success');
		expect(queue.snapshot().blocked).toBeNull();
		expect(onSuccess).toHaveBeenCalledTimes(1);
	});
});

describe('selection rules', () => {
	it('dedupes by name + size + lastModified and enqueues a new identity', async () => {
		const fetchMock = vi.fn().mockResolvedValue(ok('asset-1'));
		vi.stubGlobal('fetch', fetchMock);

		const { queue } = setup();
		const firstSelection = photo('same.jpg');
		expect(queue.addFiles([firstSelection, firstSelection])).toEqual({
			added: 1,
			duplicates: 1
		});
		await flush();

		expect(queue.addFiles([photo('same.jpg')])).toEqual({
			added: 0,
			duplicates: 1
		});
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const different = new File([new Uint8Array([1, 2, 3])], 'same.jpg', {
			type: 'image/jpeg',
			lastModified: 1_700_000_000_001
		});
		expect(queue.addFiles([different])).toEqual({ added: 1, duplicates: 0 });
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(queue.snapshot().items).toHaveLength(2);
	});

	it('rejects videos and oversized files before any request is sent', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const { queue } = setup();
		const video = new File([new Uint8Array([1])], 'clip.mp4', {
			type: 'video/mp4',
			lastModified: 1
		});
		const huge = {
			name: 'huge.jpg',
			size: MAX_UPLOAD_BYTES + 1,
			type: 'image/jpeg',
			lastModified: 2
		} as File;

		const result = queue.addFiles([video, huge]);
		await flush();

		const items = queue.snapshot().items;
		expect(result.added).toBe(2);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(items[0]?.status).toBe('error');
		expect(items[0]?.error?.status).toBe(415);
		expect(items[0]?.error?.message).toContain('not supported');
		expect(items[1]?.error?.status).toBe(413);
		expect(items[1]?.error?.message).toContain('20 MiB');
		expect(queue.snapshot().active).toBe(false);
	});

	it('never sends a video even when its client-side error row is retried', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const { queue } = setup();
		const video = new File([new Uint8Array([1])], 'clip.mp4', {
			type: 'video/mp4',
			lastModified: 1
		});
		queue.addFiles([video]);
		await flush();

		queue.retry(queue.snapshot().items[0]?.id ?? '');
		await flush();

		expect(fetchMock).not.toHaveBeenCalled();
		const [item] = queue.snapshot().items;
		expect(item?.status).toBe('error');
		expect(item?.error?.status).toBe(415);
	});

	it('ignores an in-flight result after the owner-scoped queue is reset', async () => {
		let resolveFetch: ((response: Response) => void) | undefined;
		const fetchMock = vi.fn().mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				})
		);
		vi.stubGlobal('fetch', fetchMock);

		const { queue, onSuccess } = setup();
		queue.addFiles([photo()]);
		await flush();
		expect(queue.snapshot().items[0]?.status).toBe('uploading');

		queue.reset();
		resolveFetch?.(ok('asset-old-owner'));
		await flush();

		expect(queue.snapshot().items).toEqual([]);
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it('does not close while a failed or uncertain row remains', async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValue(new TypeError('network down'));
		vi.stubGlobal('fetch', fetchMock);

		const { queue } = setup();
		queue.addFiles([photo()]);
		await flush();

		expect(queue.canClose()).toBe(false);
		expect(queue.dismissAll()).toBe(false);
		expect(queue.snapshot().items).toHaveLength(1);
	});
});
