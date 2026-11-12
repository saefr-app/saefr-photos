import {
	ApiRequestError,
	listAssets,
	type ApiError,
	type AssetPageItem
} from '#lib/api';
import { session } from '#lib/session';
import { nextCursorAfterPage } from './cursor';
import { mergeAssetPage } from './groups';

const PAGE_SIZE = 50;
const GENERIC_MESSAGE = 'Something went wrong. Try again in a moment.';

export type GalleryStatus = 'idle' | 'loading' | 'ready' | 'error';

// Module-level cache shared by the gallery and the viewer. Everything below is
// owner-scoped: a different signed-in user never sees the previous cache.
let ownerId = $state<string | null>(null);
let items = $state<AssetPageItem[]>([]);
let nextCursor = $state<string | null>(null);
let status = $state<GalleryStatus>('idle');
let error = $state<ApiError | null>(null);
let loadingMore = $state(false);
let loadMoreError = $state<ApiError | null>(null);
let hasLoadedPages = $state(false);
let scrollY = $state(0);
// A confirmed upload may land while the first page is already loading; queue
// one more honest reload instead of silently dropping the new asset.
let refreshQueued = false;
// True after a tile activation until the gallery consumes the return. While
// set, the gallery scroll listener must not overwrite the click-time snapshot
// as navigation scrolls the outgoing page to the top.
let returningFromGallery = $state(false);

// Invalidates in-flight responses after a reset or a fresh reload.
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
	scrollY = 0;
	refreshQueued = false;
	returningFromGallery = false;
}

/** Clears every cached page when the signed-in owner changes. */
function ensureOwner(): void {
	const current = session.user?.id ?? null;
	if (current !== ownerId) {
		ownerId = current;
		clearState();
	}
}

/** A protected request returned 401: drop the cache and end local session state. */
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
		const page = await listAssets({ limit: PAGE_SIZE });
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
		const page = await listAssets({
			limit: PAGE_SIZE,
			cursor: requestCursor
		});
		if (epoch !== requestEpoch) return;
		items = mergeAssetPage(items, page.items);
		// Appending is still useful, but a repeated cursor means we cannot ask
		// this server for another page; stop rather than loop.
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

/** Fresh, non-return mount: forget cached pages and load from the top. */
async function reload(): Promise<void> {
	ensureOwner();
	if (status === 'loading') return;

	refreshQueued = false;

	// Invalidate any in-flight pagination so its result cannot append to the
	// clean state we are about to request.
	epoch += 1;
	items = [];
	nextCursor = null;
	error = null;
	loadMoreError = null;
	loadingMore = false;
	hasLoadedPages = false;
	status = 'idle';
	returningFromGallery = false;

	await loadFirstPage();
}

/**
 * A confirmed `201` upload. Reload the owner's first page; if another upload
 * lands while that request is running, run one more reload instead of dropping
 * the second confirmed asset from the visible gallery.
 */
async function refreshAfterUpload(): Promise<void> {
	ensureOwner();
	if (status === 'loading') {
		refreshQueued = true;
		return;
	}
	await reload();
	if (!refreshQueued) return;
	refreshQueued = false;
	await refreshAfterUpload();
}

/** Drops a photo that the viewer learned is no longer owner-visible. */
function removeItem(id: string): void {
	ensureOwner();
	items = items.filter((item) => item.id !== id);
}

function recordScroll(y: number): void {
	ensureOwner();
	if (returningFromGallery) return;
	if (!Number.isFinite(y)) return;
	scrollY = Math.max(0, y);
}

/** Snapshot the click-time position and mark a viewer return as expected. */
function markOpenedFromGallery(): void {
	ensureOwner();
	if (typeof window !== 'undefined') scrollY = window.scrollY;
	returningFromGallery = true;
}

/** True only once, for the mount that comes back from the viewer. */
function consumeReturnedFromGallery(): boolean {
	ensureOwner();
	const returned = returningFromGallery;
	returningFromGallery = false;
	return returned;
}

export const gallery = {
	get items(): AssetPageItem[] {
		return owned() ? items : [];
	},
	get nextCursor(): string | null {
		return owned() ? nextCursor : null;
	},
	get status(): GalleryStatus {
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
	get scrollY(): number {
		return owned() ? scrollY : 0;
	},
	get belongsToCurrentUser(): boolean {
		return owned();
	},
	/**
	 * True between a gallery tile activation and the return to the gallery.
	 * The viewer uses this to decide whether `history.back()` lands on `/photos`.
	 */
	get fromGallery(): boolean {
		return owned() && returningFromGallery;
	},
	loadFirstPage,
	loadMore,
	reload,
	refreshAfterUpload,
	removeItem,
	recordScroll,
	markOpenedFromGallery,
	consumeReturnedFromGallery
};
