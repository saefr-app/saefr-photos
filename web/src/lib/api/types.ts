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
