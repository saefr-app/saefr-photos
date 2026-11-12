import {
	ApiRequestError,
	changePassword as changePasswordRequest,
	clearCsrfToken,
	getMe,
	listSessions as listSessionsRequest,
	login as loginRequest,
	logout as logoutRequest,
	logoutAll as logoutAllRequest,
	revokeSession as revokeSessionRequest,
	setCsrfToken,
	type ApiError,
	type AuthenticatedUser,
	type MeResponse,
	type SessionIdentity,
	type SessionInfo
} from '#lib/api';

export type SessionState =
	| { status: 'loading' }
	| { status: 'anonymous' }
	| {
			status: 'authenticated';
			user: AuthenticatedUser;
			session: SessionIdentity;
			assetsAvailable: boolean;
	  }
	| { status: 'unavailable'; message: string };

export type SignInResult =
	| { ok: true; user: AuthenticatedUser }
	| { ok: false; error: ApiError };

export type SessionActionResult =
	| { ok: true }
	| { ok: false; error: ApiError };

export type SessionsResult =
	| { ok: true; sessions: SessionInfo[] }
	| { ok: false; error: ApiError };

export type RevokeResult =
	| { ok: true; wasCurrent: boolean }
	| { ok: false; error: ApiError };

let state = $state<SessionState>({ status: 'loading' });
let bootstrapPromise: Promise<void> | null = null;
// One-shot destination for the anonymous redirect that follows a password
// change; the guard consumes it so the login screen can explain itself.
let pendingLoginPath: string | null = null;

function errorOf(error: unknown): ApiError {
	if (error instanceof ApiRequestError) return error.api;
	return {
		status: 0,
		message: 'Something went wrong. Try again in a moment.',
		kind: 'network'
	};
}

function userOf(response: MeResponse): AuthenticatedUser {
	return {
		id: response.id,
		username: response.username,
		role: response.role,
		passwordChangeRequired: response.passwordChangeRequired
	};
}

function adoptIdentity(response: MeResponse): void {
	setCsrfToken(response.csrfToken);
	state = {
		status: 'authenticated',
		user: userOf(response),
		session: response.session,
		assetsAvailable: response.assetsAvailable
	};
}

function adoptLogin(
	user: AuthenticatedUser,
	session: SessionIdentity,
	csrfToken: string
): void {
	setCsrfToken(csrfToken);
	state = {
		status: 'authenticated',
		user,
		session,
		// Matches GET /me: a forced password change disables asset routes.
		assetsAvailable: !user.passwordChangeRequired
	};
}

function reset(loginPath: string | null = null): void {
	clearCsrfToken();
	pendingLoginPath = loginPath;
	state = { status: 'anonymous' };
}

/** Consumes the one-shot post-change login destination, if any. */
export function takePendingLoginPath(): string | null {
	const path = pendingLoginPath;
	pendingLoginPath = null;
	return path;
}

async function loadSession(): Promise<void> {
	try {
		adoptIdentity(await getMe());
	} catch (error) {
		clearCsrfToken();
		const api = errorOf(error);
		if (api.status === 401) {
			state = { status: 'anonymous' };
			return;
		}
		state = { status: 'unavailable', message: api.message };
	}
}

/** Reusable across navigations; concurrent callers share one request. */
export function bootstrap(): Promise<void> {
	if (!bootstrapPromise) {
		bootstrapPromise = loadSession().finally(() => {
			bootstrapPromise = null;
		});
	}
	return bootstrapPromise;
}

export async function retryBootstrap(): Promise<void> {
	bootstrapPromise = null;
	state = { status: 'loading' };
	await bootstrap();
}

/**
 * The backend refuses a login that carries a cookie. When a stale session
 * cookie exists, ask the logout route to clear it (it answers 401 and clears
 * the cookie) before sending the credential.
 */
async function clearStaleCookie(): Promise<ApiError | null> {
	try {
		await logoutRequest();
		return null;
	} catch (error) {
		const api = errorOf(error);
		if (api.status === 401) return null;
		return api;
	}
}

export async function signIn(
	username: string,
	password: string
): Promise<SignInResult> {
	// Preflight: an already valid session must not send a second credential.
	try {
		const current = await getMe();
		adoptIdentity(current);
		return { ok: true, user: userOf(current) };
	} catch (error) {
		const api = errorOf(error);
		if (api.status !== 401) return { ok: false, error: api };
	}

	const stale = await clearStaleCookie();
	if (stale) return { ok: false, error: stale };

	try {
		const response = await loginRequest(username, password);
		adoptLogin(response.user, response.session, response.csrfToken);
		return { ok: true, user: response.user };
	} catch (error) {
		return { ok: false, error: errorOf(error) };
	}
}

async function endSession(call: () => Promise<void>): Promise<SessionActionResult> {
	try {
		await call();
		reset();
		return { ok: true };
	} catch (error) {
		const api = errorOf(error);
		if (api.status === 401) {
			reset();
			return { ok: true };
		}
		return { ok: false, error: api };
	}
}

export function signOut(): Promise<SessionActionResult> {
	return endSession(logoutRequest);
}

export function signOutAll(): Promise<SessionActionResult> {
	return endSession(logoutAllRequest);
}

export async function changePassword(
	currentPassword: string,
	newPassword: string
): Promise<SessionActionResult> {
	try {
		await changePasswordRequest(currentPassword, newPassword);
		// The backend cleared the cookie; no local session remains.
		reset('/login?changed=1');
		return { ok: true };
	} catch (error) {
		return { ok: false, error: errorOf(error) };
	}
}

export async function loadSessions(): Promise<SessionsResult> {
	try {
		return { ok: true, sessions: await listSessionsRequest() };
	} catch (error) {
		const api = errorOf(error);
		if (api.status === 401) reset();
		return { ok: false, error: api };
	}
}

export async function revokeSession(id: string): Promise<RevokeResult> {
	try {
		await revokeSessionRequest(id);
		const wasCurrent =
			state.status === 'authenticated' && state.session.id === id;
		if (wasCurrent) reset();
		return { ok: true, wasCurrent };
	} catch (error) {
		const api = errorOf(error);
		if (api.status === 401) {
			reset();
			return { ok: false, error: api };
		}
		return { ok: false, error: api };
	}
}

export const session = {
	get state(): SessionState {
		return state;
	},
	get user(): AuthenticatedUser | null {
		return state.status === 'authenticated' ? state.user : null;
	},
	get isAuthenticated(): boolean {
		return state.status === 'authenticated';
	},
	get isAdmin(): boolean {
		return state.status === 'authenticated' && state.user.role === 'admin';
	},
	bootstrap,
	retryBootstrap,
	signIn,
	signOut,
	signOutAll,
	changePassword,
	loadSessions,
	revokeSession,
	takePendingLoginPath
};
