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
