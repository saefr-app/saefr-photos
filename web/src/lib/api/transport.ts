import { getCsrfToken } from './csrf';
import {
	ApiRequestError,
	apiErrorForResponse,
	statusMessage
} from './errors';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RequestOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	/** A defined value is serialized as JSON. `undefined` sends no body at all. */
	body?: unknown;
	headers?: Record<string, string>;
	/** Login is the one unsafe request that must not carry the session CSRF token. */
	csrf?: boolean;
}

function parseJson(text: string): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * The single browser transport. It never retries, never sets a Cookie header,
 * and never reads a response body for private media.
 */
export async function request<T>(
	path: string,
	options: RequestOptions = {}
): Promise<T> {
	const method = options.method ?? 'GET';
	const headers: Record<string, string> = { ...options.headers };
	let body: string | undefined;

	if (options.body !== undefined) {
		headers['Content-Type'] = 'application/json';
		body = JSON.stringify(options.body);
	}

	if (UNSAFE_METHODS.has(method) && options.csrf !== false) {
		const token = getCsrfToken();
		if (token) headers['X-CSRF-Token'] = token;
	}

	let response: Response;
	try {
		response = await fetch(path, {
			method,
			headers,
			body,
			credentials: 'same-origin',
			cache: 'no-store'
		});
	} catch {
		throw new ApiRequestError({
			status: 0,
			message: statusMessage(0),
			kind: 'network'
		});
	}

	if (response.status === 204) return undefined as T;
	if (!response.ok) throw new ApiRequestError(apiErrorForResponse(response));

	const text = await response.text();
	return parseJson(text) as T;
}

/**
 * GET binary media with the same rules as `request`: same-origin credentials,
 * no browser cache, no retries and no CSRF. The body is never parsed as JSON.
 */
export async function requestBlob(path: string): Promise<Blob> {
	let response: Response;
	try {
		response = await fetch(path, {
			method: 'GET',
			credentials: 'same-origin',
			cache: 'no-store'
		});
	} catch {
		throw new ApiRequestError({
			status: 0,
			message: statusMessage(0),
			kind: 'network'
		});
	}

	if (!response.ok) throw new ApiRequestError(apiErrorForResponse(response));

	try {
		return await response.blob();
	} catch {
		throw new ApiRequestError({
			status: 0,
			message: statusMessage(0),
			kind: 'network'
		});
	}
}
