import { request, requestBlob } from './transport';
import type { Asset, AssetPage } from './types';

const ASSETS_PATH = '/api/v1/assets';

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
