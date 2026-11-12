import {
	ApiRequestError,
	listTrash,
	type ApiError,
	type TrashPageItem
} from '#lib/api';
import { nextCursorAfterPage } from '#lib/gallery/cursor';
import { mergeAssetPage } from '#lib/gallery/groups';
import { session } from '#lib/session';

const PAGE_SIZE = 50;
const GENERIC_MESSAGE = 'Something went wrong. Try again in a moment.';

export type TrashStatus = 'idle' | 'loading' | 'ready' | 'error';

// Module-level, owner-scoped Trash cache. A different signed-in user never
// inherits the previous owner's receipts or page cursor.
let ownerId = $state<string | null>(null);
let items = $state<TrashPageItem[]>([]);
let nextCursor = $state<string | null>(null);
let status = $state<TrashStatus>('idle');
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
		const page = await listTrash({ limit: PAGE_SIZE });
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
		const page = await listTrash({ limit: PAGE_SIZE, cursor: requestCursor });
		if (epoch !== requestEpoch) return;
		items = mergeAssetPage(items, page.items);
		nextCursor = nextCursorAfterPage(requestCursor, page.next_cursor);
	} catch (caught) {
		if (epoch !== requestEpoch) return;
		const api = errorOf(caught);
		if (api.status === 401) {
			expire();
			return;
		}
		// Keep the pages already on screen; only the next page failed.
		loadMoreError = api;
	} finally {
		if (epoch === requestEpoch) loadingMore = false;
	}
}

/** Fresh, non-return mount: forget cached pages and fetch from the top. */
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

/** A confirmed Restore or permanent deletion removes the row from Trash. */
function removeItem(id: string): void {
	ensureOwner();
	items = items.filter((item) => item.id !== id);
}

export const trash = {
	get items(): TrashPageItem[] {
		return owned() ? items : [];
	},
	get nextCursor(): string | null {
		return owned() ? nextCursor : null;
	},
	get status(): TrashStatus {
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
	removeItem
};
