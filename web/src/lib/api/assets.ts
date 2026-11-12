import { ApiRequestError, statusMessage } from './errors';
import {
	request,
	requestBlob,
	requestDetailed,
	requestForm
} from './transport';
import type {
	Asset,
	AssetMimeType,
	AssetPage,
	DeletionAttempt,
	DeletionPage,
	DeletionReceipt,
	LifecycleMutationResult,
	LifecycleTransition,
	TrashPage
} from './types';

const ASSETS_PATH = '/api/v1/assets';
const UPLOAD_PATH = `${ASSETS_PATH}/upload`;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LIFECYCLE_ETAG = /^"asset-lifecycle:([^"]+):(0|[1-9][0-9]*)"$/;

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

function pageQuery(options: ListAssetsOptions): string {
	const params = new URLSearchParams();
	if (options.limit !== undefined) params.set('limit', String(options.limit));
	if (options.cursor !== undefined && options.cursor !== null)
		params.set('cursor', options.cursor);
	return params.toString();
}

export interface ListAssetsOptions {
	limit?: number;
	/** Opaque server cursor; `null`/`undefined` requests the first page. */
	cursor?: string | null;
}

/**
 * Builds the exact strong lifecycle validator the backend requires. The quotes
 * are part of the value; callers must never add `W/` or strip the quotes.
 */
export function lifecycleEtag(assetId: string, version: string): string {
	return `"asset-lifecycle:${assetId}:${version}"`;
}

/**
 * Extracts the decimal lifecycle version from a strong ETag. Weak, quoted-list,
 * or malformed validators return `null` rather than inventing a version.
 */
export function parseLifecycleEtag(etag: string | null | undefined): string | null {
	if (!etag) return null;
	const match = LIFECYCLE_ETAG.exec(etag.trim());
	return match?.[2] ?? null;
}

/**
 * Prevents an If-Match-less lifecycle mutation from reaching the API. A missing
 * or weak version is an implementation defect (`428` semantics), so it fails
 * locally without a request and without faking a transition.
 */
function requireStrongLifecycleEtag(ifMatch: string): string {
	const match = LIFECYCLE_ETAG.exec(ifMatch);
	if (!match || !UUID_SEGMENT.test(match[1])) {
		throw new ApiRequestError({
			status: 428,
			message: 'Could not confirm the current photo version. Refresh and try again.',
			kind: 'http'
		});
	}
	return ifMatch;
}

/**
 * One owner-scoped active page. Ordering and pagination are server-owned; the
 * cursor is forwarded verbatim (only query-string encoded).
 */
export function listAssets(options: ListAssetsOptions = {}): Promise<AssetPage> {
	const query = pageQuery(options);
	return request<AssetPage>(query ? `${ASSETS_PATH}?${query}` : ASSETS_PATH);
}

/** One owner-scoped Trash page, sorted by `trashed_at,id` descending. */
export function listTrash(options: ListAssetsOptions = {}): Promise<TrashPage> {
	const query = pageQuery(options);
	return request<TrashPage>(
		query ? `${ASSETS_PATH}/trash?${query}` : `${ASSETS_PATH}/trash`
	);
}

/** Owner-only Trash preview. There is deliberately no Trash original route. */
export function assetTrashThumbnailPath(id: string): string {
	return `${ASSETS_PATH}/trash/${encodeURIComponent(id)}/thumbnail`;
}

export function getAsset(id: string): Promise<Asset> {
	return request<Asset>(assetPath(id));
}

/**
 * Metadata plus the server's current strong lifecycle ETag. The ETag is the
 * honest version source for a direct-link viewer that has no gallery page item.
 */
export async function getAssetWithEtag(
	id: string
): Promise<{ asset: Asset; etag: string | null }> {
	const response = await requestDetailed<Asset>(assetPath(id));
	return { asset: response.data, etag: response.etag };
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

/** Empty-body lifecycle mutation carrying a strong If-Match precondition. */
async function lifecycleMutation(
	id: string,
	action: 'trash' | 'restore',
	ifMatch: string
): Promise<LifecycleMutationResult> {
	const strong = requireStrongLifecycleEtag(ifMatch);
	const response = await requestDetailed<LifecycleTransition>(
		assetPath(id, `/${action}`),
		{
			method: 'POST',
			headers: { 'If-Match': strong }
		}
	);
	return {
		transition: response.data,
		etag: response.etag,
		status: response.status
	};
}

/** `POST /api/v1/assets/:id/trash` — empty body, strong If-Match, CSRF. */
export function trashAsset(
	id: string,
	ifMatch: string
): Promise<LifecycleMutationResult> {
	return lifecycleMutation(id, 'trash', ifMatch);
}

/** `POST /api/v1/assets/:id/restore` — empty body, strong If-Match, CSRF. */
export function restoreAsset(
	id: string,
	ifMatch: string
): Promise<LifecycleMutationResult> {
	return lifecycleMutation(id, 'restore', ifMatch);
}

/**
 * `DELETE /api/v1/assets/:id` — only a trashed asset, empty body, strong
 * If-Match. A 202 response is accepted-but-pending, never completed.
 */
export async function permanentlyDeleteAsset(
	id: string,
	ifMatch: string
): Promise<DeletionAttempt> {
	const strong = requireStrongLifecycleEtag(ifMatch);
	const response = await requestDetailed<DeletionReceipt>(assetPath(id), {
		method: 'DELETE',
		headers: { 'If-Match': strong }
	});
	return {
		receipt: response.data ?? null,
		status: response.status,
		location: response.location,
		etag: response.etag
	};
}

/** One owner-scoped page of pending permanent-deletion receipts. */
export function listDeletions(
	options: ListAssetsOptions = {}
): Promise<DeletionPage> {
	const query = pageQuery(options);
	return request<DeletionPage>(
		query ? `${ASSETS_PATH}/deletions?${query}` : `${ASSETS_PATH}/deletions`
	);
}

export function getDeletion(id: string): Promise<DeletionReceipt> {
	return request<DeletionReceipt>(
		`${ASSETS_PATH}/deletions/${encodeURIComponent(id)}`
	);
}

/**
 * Explicit user-initiated retry. Sends an empty body, Origin/CSRF, and no
 * If-Match. A completed receipt is a backend no-op; the UI shows it as done.
 */
export async function retryDeletion(id: string): Promise<DeletionAttempt> {
	const response = await requestDetailed<DeletionReceipt>(
		`${ASSETS_PATH}/deletions/${encodeURIComponent(id)}/retry`,
		{ method: 'POST' }
	);
	return {
		receipt: response.data ?? null,
		status: response.status,
		location: response.location,
		etag: response.etag
	};
}
