import { ApiRequestError, statusMessage } from './errors';
import { request, requestBlob, requestForm } from './transport';
import type { Asset, AssetMimeType, AssetPage } from './types';

const ASSETS_PATH = '/api/v1/assets';
const UPLOAD_PATH = `${ASSETS_PATH}/upload`;

/** Backend upload cap: 20 MiB per file. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * A hung request must become an uncertain outcome, not a permanent spinner.
 * The server may still commit after this client gives up, so the UI never
 * retries by itself.
 */
export const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** The only image formats the backend accepts for upload. */
export const ACCEPTED_UPLOAD_MIME_TYPES: readonly AssetMimeType[] = [
	'image/jpeg',
	'image/png',
	'image/webp'
];

/** `File.type` is lower-case by specification; compare it exactly. */
export function isAcceptedUploadMimeType(
	value: string
): value is AssetMimeType {
	return (ACCEPTED_UPLOAD_MIME_TYPES as readonly string[]).includes(value);
}

function assetPath(id: string, suffix = ''): string {
	return `${ASSETS_PATH}/${encodeURIComponent(id)}${suffix}`;
}

export interface ListAssetsOptions {
	limit?: number;
	/** Opaque server cursor; `null`/`undefined` requests the first page. */
	cursor?: string | null;
}

/**
 * One owner-scoped active page. Ordering and pagination are server-owned; the
 * cursor is forwarded verbatim (only query-string encoded).
 */
export function listAssets(options: ListAssetsOptions = {}): Promise<AssetPage> {
	const params = new URLSearchParams();
	if (options.limit !== undefined) params.set('limit', String(options.limit));
	if (options.cursor !== undefined && options.cursor !== null)
		params.set('cursor', options.cursor);
	const query = params.toString();
	return request<AssetPage>(
		query ? `${ASSETS_PATH}?${query}` : ASSETS_PATH
	);
}

export function getAsset(id: string): Promise<Asset> {
	return request<Asset>(assetPath(id));
}

/** Same-origin private URL for the generated JPEG thumbnail. */
export function assetThumbnailPath(id: string): string {
	return assetPath(id, '/thumbnail');
}

/** Same-origin private URL for the original bytes. */
export function assetOriginalPath(id: string): string {
	return assetPath(id, '/original');
}

/** Fetch original bytes through the shared binary transport. */
export function fetchAssetOriginal(id: string): Promise<Blob> {
	return requestBlob(assetOriginalPath(id));
}

/**
 * Uploads one file as the single multipart `file` part. The backend commits on
 * `201`; any failure is surfaced without retrying. A `201` whose body cannot be
 * read is treated as uncertain, because the server may already have committed.
 */
export async function uploadAsset(file: File): Promise<Asset> {
	const form = new FormData();
	form.append('file', file, file.name);

	const asset = await requestForm<Asset>(UPLOAD_PATH, form, {
		timeoutMs: UPLOAD_TIMEOUT_MS
	});
	if (
		!asset ||
		typeof asset.id !== 'string' ||
		typeof asset.filename !== 'string' ||
		typeof asset.mime_type !== 'string' ||
		typeof asset.size !== 'number' ||
		typeof asset.created_at !== 'string'
	) {
		throw new ApiRequestError({
			status: 0,
			message: statusMessage(0),
			kind: 'network'
		});
	}
	return asset;
}
