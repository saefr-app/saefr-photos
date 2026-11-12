import type { ApiError } from './types';

const MESSAGES: Readonly<Record<number, string>> = {
	400: 'The request could not be completed. Check the information and try again.',
	401: 'Your session has ended. Sign in again to continue.',
	403: 'You do not have permission to do that.',
	404: 'We could not find that item.',
	409: 'That action conflicts with the current state. Refresh and try again.',
	412: 'This item changed since you last loaded it. Refresh before trying again.',
	413: 'That file is too large. The limit is 20 MiB.',
	415: 'That file type is not supported.',
	428: 'The request was missing required information. Refresh and try again.',
	503: 'Saefr is temporarily unavailable. Try again in a moment.'
};

export function statusMessage(
	status: number,
	retryAfterSeconds?: number
): string {
	if (status === 0)
		return 'Could not reach Saefr. Check your connection and try again.';
	if (status === 429)
		return retryAfterSeconds && retryAfterSeconds > 0
			? `Too many attempts. Try again in ${retryAfterSeconds} seconds.`
			: 'Too many attempts. Try again later.';
	return (
		MESSAGES[status] ?? 'Something went wrong. Try again in a moment.'
	);
}

/** Numeric Retry-After only; HTTP-date values are ignored rather than guessed. */
export function retryAfterSeconds(response: Response): number | undefined {
	const raw = response.headers.get('retry-after');
	if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
	const seconds = Number(raw.trim());
	return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Builds a safe client error. The backend envelope is intentionally not
 * surfaced: it may contain internal wording, and the UI uses fixed copy.
 */
export function apiErrorForResponse(response: Response): ApiError {
	const retry = retryAfterSeconds(response);
	return {
		status: response.status,
		message: statusMessage(response.status, retry),
		kind: response.status === 503 ? 'unavailable' : 'http',
		...(retry === undefined ? {} : { retryAfterSeconds: retry })
	};
}

export class ApiRequestError extends Error {
	readonly api: ApiError;

	constructor(api: ApiError) {
		super(api.message);
		this.name = 'ApiRequestError';
		this.api = api;
	}

	get status(): number {
		return this.api.status;
	}
}
