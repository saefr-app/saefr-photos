import { request } from './transport';
import type {
	LoginResponse,
	MeResponse,
	SessionInfo
} from './types';

export function getMe(): Promise<MeResponse> {
	return request<MeResponse>('/api/v1/me');
}

export function login(
	username: string,
	password: string
): Promise<LoginResponse> {
	return request<LoginResponse>('/api/v1/auth/login', {
		method: 'POST',
		headers: { 'X-Saefr-Login': '1' },
		body: { username, password },
		csrf: false
	});
}

/** Empty request: no body and no JSON content type. */
export function logout(): Promise<void> {
	return request<void>('/api/v1/auth/logout', { method: 'POST' });
}

/** Empty request: no body and no JSON content type. */
export function logoutAll(): Promise<void> {
	return request<void>('/api/v1/auth/logout-all', { method: 'POST' });
}

export function changePassword(
	currentPassword: string,
	newPassword: string
): Promise<void> {
	return request<void>('/api/v1/auth/password', {
		method: 'POST',
		body: { currentPassword, newPassword }
	});
}

export function listSessions(): Promise<SessionInfo[]> {
	return request<SessionInfo[]>('/api/v1/auth/sessions');
}

/** Empty request: no body and no JSON content type. */
export function revokeSession(id: string): Promise<void> {
	return request<void>(
		`/api/v1/auth/sessions/${encodeURIComponent(id)}`,
		{ method: 'DELETE' }
	);
}
