export type Role = 'admin' | 'user';

export interface AuthenticatedUser {
	id: string;
	username: string;
	role: Role;
	passwordChangeRequired: boolean;
}

export interface SessionIdentity {
	id: string;
	expiresAt: string;
}

export interface MeResponse extends AuthenticatedUser {
	session: SessionIdentity;
	csrfToken: string;
	assetsAvailable: boolean;
}

export interface LoginResponse {
	user: AuthenticatedUser;
	session: SessionIdentity;
	csrfToken: string;
}

export interface SessionInfo {
	id: string;
	createdAt: string;
	expiresAt: string;
	current: boolean;
}

/** Formats the backend accepts and reports for stored photos. */
export type AssetMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

/** `GET /api/v1/assets/:id` body (no lifecycle version). */
export interface Asset {
	id: string;
	filename: string;
	mime_type: AssetMimeType;
	size: number;
	created_at: string;
}

/** Page item: the metadata response plus its current lifecycle version. */
export interface AssetPageItem extends Asset {
	lifecycle_version: string;
}

/** `GET /api/v1/assets` body. `next_cursor` is opaque and server-owned. */
export interface AssetPage {
	items: AssetPageItem[];
	next_cursor: string | null;
}

/** `GET /api/v1/assets/trash` item: an active-page item plus its Trash time. */
export interface TrashPageItem extends AssetPageItem {
	trashed_at: string;
}

/** `GET /api/v1/assets/trash` body. */
export interface TrashPage {
	items: TrashPageItem[];
	next_cursor: string | null;
}

/** `POST /:id/trash` and `POST /:id/restore` body. */
export interface LifecycleTransition {
	id: string;
	state: 'active' | 'trashed';
	trashed_at: string | null;
	lifecycle_version: string;
}

/** Owner-scoped permanent-deletion receipt. Never contains storage internals. */
export interface DeletionReceipt {
	asset_id: string;
	status: 'pending' | 'completed';
	requested_at: string;
	completed_at: string | null;
	last_error_code: string | null;
}

/** `GET /api/v1/assets/deletions` body. Pending receipts only. */
export interface DeletionPage {
	items: DeletionReceipt[];
	next_cursor: string | null;
}

/** Transport metadata that lifecycle callers need but normal JSON calls ignore. */
export interface ResponseMeta {
	status: number;
	/** Strong ETag only when the server supplied one. */
	etag: string | null;
	location: string | null;
}

export interface DetailedResponse<T> extends ResponseMeta {
	data: T;
}

/** Result of a Trash/Restore mutation, including the fresh version for Undo. */
export interface LifecycleMutationResult {
	transition: LifecycleTransition;
	etag: string | null;
	status: number;
}

/** Result of `DELETE /api/v1/assets/:id` (200 completed or 202 pending). */
export interface DeletionAttempt {
	receipt: DeletionReceipt | null;
	status: number;
	location: string | null;
	etag: string | null;
}

/** Sanitized error envelope documented by the backend. */
export interface ApiErrorEnvelope {
	statusCode: number;
	message: string;
	error: string;
}

export type ApiErrorKind = 'http' | 'network' | 'unavailable';

export interface ApiError {
	/** HTTP status, or 0 for a network failure. */
	status: number;
	/** Safe, client-authored copy. Never raw backend text. */
	message: string;
	kind: ApiErrorKind;
	retryAfterSeconds?: number;
}
