import {
	ApiRequestError,
	listDeletions,
	type ApiError,
	type DeletionReceipt
} from '#lib/api';
import { nextCursorAfterPage } from '#lib/gallery/cursor';
import { session } from '#lib/session';
import { applyRetryOutcome, mergeReceipts } from './store-helpers';

const PAGE_SIZE = 50;
const GENERIC_MESSAGE = 'Something went wrong. Try again in a moment.';

export type DeletionsStatus = 'idle' | 'loading' | 'ready' | 'error';

// Owner-scoped list of receipts still awaiting storage completion. Completed
// receipts are removed from this view; detail pages can still fetch them.
let ownerId = $state<string | null>(null);
let items = $state<DeletionReceipt[]>([]);
let nextCursor = $state<string | null>(null);
let status = $state<DeletionsStatus>('idle');
let error = $state<ApiError | null>(null);
let loadingMore = $state(false);
let loadMoreError = $state<ApiError | null>(null);
let hasLoadedPages = $state(false);

let epoch = 0;

function errorOf(caught: unknown): ApiError {
	if (caught instanceof ApiRequestError) return caught.api;
	return { status: 0, message: GENERIC_MESSAGE, kind: 'network' };
}

function owned(): boolean {
	return ownerId !== null && ownerId === (session.user?.id ?? null);
}

function clearState(): void {
	epoch += 1;
	items = [];
	nextCursor = null;
	status = 'idle';
	error = null;
	loadingMore = false;
	loadMoreError = null;
	hasLoadedPages = false;
}

function ensureOwner(): void {
	const current = session.user?.id ?? null;
	if (current !== ownerId) {
		ownerId = current;
		clearState();
	}
}

function expire(): void {
	clearState();
	ownerId = null;
	session.expire();
}

async function loadFirstPage(): Promise<void> {
	if (status === 'loading') return;
	ensureOwner();

	status = 'loading';
	error = null;
	loadMoreError = null;
	const requestEpoch = epoch;

	try {
		const page = await listDeletions({ limit: PAGE_SIZE });
		if (epoch !== requestEpoch) return;
		items = page.items;
		nextCursor = nextCursorAfterPage(null, page.next_cursor);
		hasLoadedPages = true;
		status = 'ready';
	} catch (caught) {
		if (epoch !== requestEpoch) return;
		const api = errorOf(caught);
		if (api.status === 401) {
			expire();
			return;
		}
		error = api;
		status = 'error';
	}
}

async function loadMore(): Promise<void> {
	ensureOwner();
	if (status !== 'ready' || nextCursor === null || loadingMore) return;

	const requestCursor = nextCursor;
	const requestEpoch = epoch;
	loadingMore = true;
	loadMoreError = null;

	try {
		const page = await listDeletions({
			limit: PAGE_SIZE,
			cursor: requestCursor
		});
		if (epoch !== requestEpoch) return;
		items = mergeReceipts(items, page.items);
		nextCursor = nextCursorAfterPage(requestCursor, page.next_cursor);
	} catch (caught) {
		if (epoch !== requestEpoch) return;
		const api = errorOf(caught);
		if (api.status === 401) {
			expire();
			return;
		}
		loadMoreError = api;
	} finally {
		if (epoch === requestEpoch) loadingMore = false;
	}
}

async function reload(): Promise<void> {
	ensureOwner();
	if (status === 'loading') return;

	epoch += 1;
	items = [];
	nextCursor = null;
	error = null;
	loadMoreError = null;
	loadingMore = false;
	hasLoadedPages = false;
	status = 'idle';

	await loadFirstPage();
}

/** A 200 retry (or a completed lookup) removes the receipt from the list. */
function removeItem(id: string): void {
	ensureOwner();
	items = items.filter((receipt) => receipt.asset_id !== id);
}

/** Applies a user-initiated retry outcome: 200 removes, 202 replaces. */
function applyRetry(receipt: DeletionReceipt, status: number): void {
	ensureOwner();
	items = applyRetryOutcome(items, receipt, status);
}

export const deletions = {
	get items(): DeletionReceipt[] {
		return owned() ? items : [];
	},
	get nextCursor(): string | null {
		return owned() ? nextCursor : null;
	},
	get status(): DeletionsStatus {
		return owned() ? status : 'idle';
	},
	get error(): ApiError | null {
		return owned() ? error : null;
	},
	get loadingMore(): boolean {
		return owned() ? loadingMore : false;
	},
	get loadMoreError(): ApiError | null {
		return owned() ? loadMoreError : null;
	},
	get hasLoaded(): boolean {
		return owned() && hasLoadedPages;
	},
	get belongsToCurrentUser(): boolean {
		return owned();
	},
	loadFirstPage,
	loadMore,
	reload,
	removeItem,
	applyRetry
};
