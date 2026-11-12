<script lang="ts">
	import {
		ArrowLeft,
		ArrowRight,
		Download,
		Ellipsis,
		ImageOff,
		Info,
		Loader,
		Minus,
		Plus,
		RefreshCw,
		Trash2,
		X
	} from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import {
		ApiRequestError,
		assetOriginalPath,
		assetThumbnailPath,
		fetchAssetOriginal,
		getAssetWithEtag,
		lifecycleEtag,
		parseLifecycleEtag,
		restoreAsset,
		trashAsset,
		type ApiError,
		type Asset,
		type AssetPageItem
	} from '#lib/api';
	import { toast } from '#lib/feedback/toast.svelte';
	import { gallery } from '#lib/gallery/gallery.svelte';
	import { neighborAssets } from '#lib/gallery/navigation';
	import { ZOOM_MAX, ZOOM_MIN, zoomIn, zoomOut } from '#lib/gallery/zoom';
	import { session } from '#lib/session';
	import ViewerInfo from './ViewerInfo.svelte';
	import ZoomableImage from './ZoomableImage.svelte';

	let { id }: { id: string } = $props();

	type LoadStatus = 'loading' | 'ready' | 'error' | 'not-found';

	// A gallery tile click leaves its page in the module cache; show that copy
	// immediately while the freshness request runs.
	const cached = gallery.items.find((item) => item.id === id) ?? null;

	let asset = $state<Asset | null>(cached);
	let lifecycleVersion = $state<string | null>(
		cached?.lifecycle_version ?? null
	);
	let loadStatus = $state<LoadStatus>(cached ? 'ready' : 'loading');
	let loadError = $state<ApiError | null>(null);
	let infoOpen = $state(false);
	let infoButton = $state<HTMLButtonElement | null>(null);
	let closeButton = $state<HTMLButtonElement | null>(null);
	let zoomLevel = $state(ZOOM_MIN);
	let downloadBusy = $state(false);
	let downloadError = $state('');
	let originalFailed = $state(false);
	let originalNonce = $state(0);

	let menuOpen = $state(false);
	let menuButton = $state<HTMLButtonElement | null>(null);
	let menuPanel = $state<HTMLDivElement | null>(null);
	let menuItem = $state<HTMLButtonElement | null>(null);
	let trashBusy = $state(false);
	let actionError = $state('');

	let requestEpoch = 0;
	const objectUrls = new Set<string>();
	const revokeTimers = new Set<ReturnType<typeof setTimeout>>();

	const neighbors = $derived(neighborAssets(gallery.items, id));
	const previous = $derived(neighbors?.previous ?? null);
	const next = $derived(neighbors?.next ?? null);
	const originalSrc = $derived(
		asset
			? `${assetOriginalPath(asset.id)}${
					originalNonce > 0 ? `?retry=${originalNonce}` : ''
				}`
			: ''
	);

	function errorOf(caught: unknown): ApiError {
		if (caught instanceof ApiRequestError) return caught.api;
		return {
			status: 0,
			message: 'Something went wrong. Try again in a moment.',
			kind: 'network'
		};
	}

	async function loadMetadata() {
		const epoch = ++requestEpoch;
		if (!asset) loadStatus = 'loading';
		loadError = null;
		actionError = '';

		try {
			const fresh = await getAssetWithEtag(id);
			if (epoch !== requestEpoch) return;
			asset = fresh.asset;
			// The body has no lifecycle version. The strong ETag on this response
			// is the honest current version for a direct-link viewer.
			const fromHeader = parseLifecycleEtag(fresh.etag);
			if (fromHeader !== null) lifecycleVersion = fromHeader;
			loadStatus = 'ready';
		} catch (caught) {
			if (epoch !== requestEpoch) return;
			const api = errorOf(caught);
			if (api.status === 401) {
				session.expire();
				return;
			}
			// Invalid UUID (`400`) and owner-scoped missing/trashed (`404`) both
			// mean there is no photo to show. Never fall back to a fixture.
			if (api.status === 400 || api.status === 404) {
				gallery.removeItem(id);
				asset = null;
				loadStatus = 'not-found';
				return;
			}
			loadError = api;
			// A cached gallery item remains honest evidence of the photo; keep
			// showing it when only freshness failed.
			loadStatus = asset ? 'ready' : 'error';
		}
	}

	onMount(() => {
		void loadMetadata();
		closeButton?.focus({ preventScroll: true });

		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';

		return () => {
			requestEpoch += 1;
			document.body.style.overflow = previousOverflow;
			for (const timer of revokeTimers) clearTimeout(timer);
			revokeTimers.clear();
			for (const url of objectUrls) URL.revokeObjectURL(url);
			objectUrls.clear();
		};
	});

	function closeViewer() {
		if (
			gallery.fromGallery &&
			typeof window !== 'undefined' &&
			window.history.length > 1
		) {
			history.back();
			return;
		}
		void goto('/photos');
	}

	function goTo(target: AssetPageItem | null): void {
		if (!target || infoOpen || menuOpen) return;
		// SvelteKit 3 replaced `noScroll`/`keepFocus` with `reset: false` and
		// `replaceState` with `replace`; together they keep the viewer URL as one
		// replaced history entry, without scrolling or dropping focus.
		void goto(`/photos/${encodeURIComponent(target.id)}`, {
			replace: true,
			reset: false
		});
	}

	function openInfo() {
		if (!asset) return;
		infoOpen = true;
	}

	function closeInfo() {
		infoOpen = false;
		infoButton?.focus({ preventScroll: true });
	}

	function toggleInfo() {
		if (infoOpen) closeInfo();
		else openInfo();
	}

	function closeMenu(restoreFocus = false): void {
		menuOpen = false;
		if (restoreFocus) menuButton?.focus({ preventScroll: true });
	}

	async function toggleMenu(): Promise<void> {
		if (trashBusy) return;
		actionError = '';
		menuOpen = !menuOpen;
		if (menuOpen) {
			await tick();
			menuItem?.focus({ preventScroll: true });
		}
	}

	function handleDocumentClick(event: MouseEvent): void {
		if (!menuOpen) return;
		const target = event.target;
		if (!(target instanceof Node)) return;
		if (menuButton?.contains(target) || menuPanel?.contains(target)) return;
		closeMenu();
	}

	function handleMenuKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeMenu(true);
			return;
		}
		if (event.key === 'Tab') {
			// Let focus leave naturally; the next click re-opens the menu.
			closeMenu();
			return;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			menuItem?.focus({ preventScroll: true });
		}
	}

	async function moveToTrash(): Promise<void> {
		if (!asset || trashBusy) return;
		closeMenu();
		actionError = '';

		if (!lifecycleVersion) {
			await loadMetadata();
			if (!lifecycleVersion) {
				actionError =
					'Could not confirm the current photo version. Refresh and try again.';
				return;
			}
		}

		trashBusy = true;
		const currentId = asset.id;
		const currentVersion = lifecycleVersion;
		const filename = asset.filename;

		try {
			const result = await trashAsset(
				currentId,
				lifecycleEtag(currentId, currentVersion)
			);
			const returned =
				result.transition.lifecycle_version ||
				parseLifecycleEtag(result.etag) ||
				null;

			// Only a confirmed 200 transition removes the photo and offers Undo.
			gallery.removeItem(currentId);
			toast.show({
				title: 'Moved to Trash',
				description: filename,
				actionLabel: returned ? 'Undo' : '',
				onAction: returned
					? () => void undoTrash(currentId, returned, filename)
					: undefined,
				duration: 8000
			});
			void goto('/photos');
		} catch (caught) {
			const api = errorOf(caught);
			if (api.status === 401) {
				session.expire();
				return;
			}
			if (api.status === 412) {
				// Stale validator: refresh metadata and require a renewed action.
				await loadMetadata();
				actionError =
					'This photo changed since you opened it. Review it and try again.';
				return;
			}
			if (api.status === 428) {
				actionError =
					'Could not confirm the photo version. Refresh this photo and try again.';
				return;
			}
			if (api.status === 503) {
				actionError =
					'Saefr is temporarily unavailable. The photo was not moved to Trash.';
				return;
			}
			if (api.status === 0) {
				// The request may or may not have reached the server. Do not claim
				// success; refresh the authoritative metadata before retrying.
				await loadMetadata();
				actionError =
					'Could not confirm whether the photo moved. Refresh this photo before trying again.';
				return;
			}
			actionError = api.message;
		} finally {
			trashBusy = false;
		}
	}

	async function undoTrash(
		assetId: string,
		version: string,
		filename: string
	): Promise<void> {
		try {
			await restoreAsset(assetId, lifecycleEtag(assetId, version));
			toast.show({
				title: 'Photo restored',
				description: `${filename} is back in Photos.`
			});
			void gallery.reload();
		} catch (caught) {
			const api = errorOf(caught);
			if (api.status === 401) {
				session.expire();
				return;
			}
			const message =
				api.status === 412
					? 'That photo changed since it was moved. Open Trash to restore it.'
					: api.status === 0
						? 'Could not confirm the restore. Check Trash before trying again.'
						: api.message;
			toast.show({
				title: 'Could not restore',
				description: message,
				duration: 6000
			});
		}
	}

	function isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		return (
			tag === 'INPUT' ||
			tag === 'TEXTAREA' ||
			tag === 'SELECT' ||
			target.isContentEditable
		);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey)
			return;
		if (isTypingTarget(event.target)) return;

		if (event.key === 'Escape') {
			event.preventDefault();
			if (menuOpen) closeMenu(true);
			else if (infoOpen) closeInfo();
			else closeViewer();
			return;
		}

		// `+` usually arrives with Shift; the "ignore modified keys" rule is
		// about browser/OS accelerators, not the Shift needed to type a plus.
		if (event.key === '+' || event.key === '=') {
			event.preventDefault();
			zoomLevel = zoomIn(zoomLevel);
			return;
		}
		if (event.key === '-' || event.key === '_') {
			event.preventDefault();
			zoomLevel = zoomOut(zoomLevel);
			return;
		}

		if (event.shiftKey || infoOpen || menuOpen) return;
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		const target = event.key === 'ArrowLeft' ? previous : next;
		if (!target) return;
		event.preventDefault();
		goTo(target);
	}

	function revokeObjectUrl(url: string) {
		URL.revokeObjectURL(url);
		objectUrls.delete(url);
	}

	async function downloadOriginal() {
		if (!asset || downloadBusy) return;
		downloadBusy = true;
		downloadError = '';
		const current = asset;

		try {
			const blob = await fetchAssetOriginal(current.id);
			const url = URL.createObjectURL(blob);
			objectUrls.add(url);

			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = current.filename;
			anchor.rel = 'noopener';
			anchor.style.display = 'none';
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();

			// Give the browser a moment to hand the blob to its download flow,
			// then release it. Every URL is also revoked on unmount.
			const timer = setTimeout(() => {
				revokeTimers.delete(timer);
				revokeObjectUrl(url);
			}, 1500);
			revokeTimers.add(timer);
		} catch (caught) {
			const api = errorOf(caught);
			if (api.status === 401) {
				session.expire();
				return;
			}
			downloadError = api.message;
		} finally {
			downloadBusy = false;
		}
	}

	function retryOriginal() {
		originalFailed = false;
		originalNonce += 1;
	}

	function handleZoomIn() {
		zoomLevel = zoomIn(zoomLevel);
	}

	function handleZoomOut() {
		zoomLevel = zoomOut(zoomLevel);
	}
</script>

<svelte:window onkeydown={handleKeydown} onclick={handleDocumentClick} />

<svelte:head>
	<title>{asset ? `${asset.filename} · Saefr` : 'Photo · Saefr'}</title>
</svelte:head>

<div class="viewer">
	<header class="toolbar">
		<button
			bind:this={closeButton}
			type="button"
			class="icon-action"
			aria-label="Close viewer"
			onclick={closeViewer}
		>
			<X size={21} aria-hidden="true" />
		</button>

		<span class="filename" title={asset?.filename ?? undefined}>
			{asset?.filename ?? ''}
		</span>

		{#if asset}
			<div class="toolbar-actions">
				<button
					bind:this={infoButton}
					type="button"
					class="icon-action"
					aria-label="Photo information"
					aria-controls="photo-information"
					aria-expanded={infoOpen}
					onclick={toggleInfo}
				>
					<Info size={20} aria-hidden="true" />
				</button>
				<button
					type="button"
					class="icon-action"
					aria-label={downloadBusy
						? 'Preparing download'
						: 'Download original'}
					aria-busy={downloadBusy}
					disabled={downloadBusy}
					onclick={() => void downloadOriginal()}
				>
					{#if downloadBusy}
						<span class="spin" aria-hidden="true">
							<Loader size={20} />
						</span>
					{:else}
						<Download size={20} aria-hidden="true" />
					{/if}
				</button>
				<div class="menu-wrap">
					<button
						bind:this={menuButton}
						type="button"
						class="icon-action"
						aria-label="More photo actions"
						aria-haspopup="menu"
						aria-controls="photo-actions"
						aria-expanded={menuOpen}
						aria-busy={trashBusy}
						disabled={trashBusy}
						onclick={() => void toggleMenu()}
					>
						{#if trashBusy}
							<span class="spin" aria-hidden="true">
								<Loader size={20} />
							</span>
						{:else}
							<Ellipsis size={20} aria-hidden="true" />
						{/if}
					</button>
					{#if menuOpen}
						<div
							bind:this={menuPanel}
							id="photo-actions"
							class="menu"
							role="menu"
							tabindex="-1"
							aria-label="Photo actions"
							onkeydown={handleMenuKeydown}
						>
							<button
								bind:this={menuItem}
								type="button"
								role="menuitem"
								class="menu-item"
								onclick={() => void moveToTrash()}
							>
								<Trash2 size={16} aria-hidden="true" />
								<span>Move to Trash</span>
							</button>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</header>

	{#if loadStatus === 'not-found'}
		<div class="state" role="status">
			<ImageOff size={28} aria-hidden="true" />
			<h1>Photo unavailable</h1>
			<p>This photo is not available in your library.</p>
			<div class="state-actions">
				<button type="button" class="text-action" onclick={closeViewer}>
					Back to photos
				</button>
			</div>
		</div>
	{:else if loadStatus === 'error'}
		<div class="state" role="alert">
			<ImageOff size={28} aria-hidden="true" />
			<h1>Photo could not be loaded</h1>
			<p>{loadError?.message ?? 'Try again in a moment.'}</p>
			<div class="state-actions">
				<button
					type="button"
					class="text-action"
					onclick={() => void loadMetadata()}
				>
					<RefreshCw size={15} aria-hidden="true" />
					<span>Retry</span>
				</button>
				<button type="button" class="text-action" onclick={closeViewer}>
					Back to photos
				</button>
			</div>
		</div>
	{:else if !asset}
		<div class="state" role="status">
			<p>Loading photo…</p>
		</div>
	{:else}
		<div class="stage-wrap">
			{#if previous && !infoOpen}
				<button
					type="button"
					class="nav-arrow previous"
					aria-label="Previous photo"
					onclick={() => goTo(previous)}
				>
					<ArrowLeft size={22} aria-hidden="true" />
				</button>
			{/if}

			<ZoomableImage
				src={originalSrc}
				thumbnailSrc={assetThumbnailPath(asset.id)}
				alt={asset.filename}
				bind:zoom={zoomLevel}
				onprevious={() => goTo(previous)}
				onnext={() => goTo(next)}
				onloaderror={() => (originalFailed = true)}
			/>

			{#if next && !infoOpen}
				<button
					type="button"
					class="nav-arrow next"
					aria-label="Next photo"
					onclick={() => goTo(next)}
				>
					<ArrowRight size={22} aria-hidden="true" />
				</button>
			{/if}

			{#if originalFailed || downloadError || actionError}
				<div class="notices">
					{#if actionError}
						<div class="notice" role="alert">
							<span>{actionError}</span>
							<button
								type="button"
								class="text-action"
								onclick={() => void loadMetadata()}
							>
								<RefreshCw size={15} aria-hidden="true" />
								<span>Refresh</span>
							</button>
						</div>
					{/if}
					{#if originalFailed}
						<div class="notice" role="alert">
							<span>The original photo could not be loaded.</span>
							<button
								type="button"
								class="text-action"
								onclick={retryOriginal}
							>
								<RefreshCw size={15} aria-hidden="true" />
								<span>Retry</span>
							</button>
						</div>
					{/if}
					{#if downloadError}
						<div class="notice" role="alert">
							<span>{downloadError}</span>
							<button
								type="button"
								class="text-action"
								onclick={() => void downloadOriginal()}
							>
								Retry
							</button>
						</div>
					{/if}
				</div>
			{/if}

			<div class="zoom-controls" role="group" aria-label="Zoom controls">
				<button
					type="button"
					aria-label="Zoom out"
					disabled={zoomLevel <= ZOOM_MIN}
					onclick={handleZoomOut}
				>
					<Minus size={18} aria-hidden="true" />
				</button>
				<span class="zoom-value">{Math.round(zoomLevel * 100)}%</span>
				<button
					type="button"
					aria-label="Zoom in"
					disabled={zoomLevel >= ZOOM_MAX}
					onclick={handleZoomIn}
				>
					<Plus size={18} aria-hidden="true" />
				</button>
			</div>
		</div>
	{/if}

	{#if downloadBusy}
		<span class="sr-only" role="status">Preparing download…</span>
	{/if}
	{#if trashBusy}
		<span class="sr-only" role="status">Moving photo to Trash…</span>
	{/if}

	{#if infoOpen && asset}
		<ViewerInfo {asset} onclose={closeInfo} />
	{/if}
</div>

<style>
	.viewer {
		position: fixed;
		inset: 0;
		z-index: 10;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--color-viewer);
		color: var(--color-text-primary);
	}

	.toolbar {
		position: relative;
		z-index: 6;
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 10px;
		min-height: calc(64px + env(safe-area-inset-top));
		padding: env(safe-area-inset-top) 16px 0 12px;
	}

	.icon-action {
		display: grid;
		place-items: center;
		min-width: 44px;
		min-height: 44px;
		padding: 0;
		border: 0;
		border-radius: 8px;
		color: var(--color-text-secondary);
		background: none;
		cursor: pointer;
	}

	.icon-action:hover:not(:disabled) {
		color: var(--color-text-primary);
	}

	.icon-action:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.filename {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		color: var(--color-text-secondary);
		font-size: 13px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.toolbar-actions {
		display: flex;
		align-items: center;
	}

	.menu-wrap {
		position: relative;
	}

	.menu {
		position: absolute;
		z-index: 8;
		top: calc(100% + 4px);
		right: 0;
		min-width: 188px;
		padding: 6px;
		border-radius: 12px;
		background: var(--color-elevated);
		box-shadow: 0 16px 40px #0009;
	}

	.menu-item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 44px;
		padding: 0 10px;
		border: 0;
		border-radius: 8px;
		color: var(--color-text-secondary);
		background: none;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}

	.menu-item:hover,
	.menu-item:focus-visible {
		color: var(--color-text-primary);
		background: var(--color-input);
	}

	.stage-wrap {
		position: relative;
		flex: 1 1 auto;
		min-height: 0;
	}

	.nav-arrow {
		position: absolute;
		z-index: 4;
		top: 50%;
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: #00000066;
		color: var(--color-text-secondary);
		cursor: pointer;
		transform: translateY(-50%);
	}

	.nav-arrow:hover {
		background: #00000099;
		color: var(--color-text-primary);
	}

	.previous {
		left: 16px;
	}

	.next {
		right: 16px;
	}

	.zoom-controls {
		position: absolute;
		z-index: 5;
		bottom: calc(12px + env(safe-area-inset-bottom));
		left: 16px;
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.zoom-controls button {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border: 0;
		color: var(--color-text-primary);
		background: none;
		cursor: pointer;
	}

	.zoom-controls button:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.zoom-value {
		min-width: 44px;
		color: var(--color-text-secondary);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		text-align: center;
	}

	.notices {
		position: absolute;
		z-index: 6;
		bottom: calc(64px + env(safe-area-inset-bottom));
		left: 50%;
		display: grid;
		gap: 8px;
		width: min(520px, calc(100vw - 32px));
		transform: translateX(-50%);
	}

	.notice {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		padding: 10px 14px;
		border-radius: 12px;
		background: var(--color-elevated);
		box-shadow: 0 12px 30px #0008;
		color: var(--color-text-secondary);
		font-size: 13px;
		line-height: 1.4;
	}

	.notice .text-action {
		flex: 0 0 auto;
		min-height: 36px;
		color: var(--color-text-primary);
	}

	.state {
		display: grid;
		flex: 1 1 auto;
		justify-items: center;
		align-content: center;
		gap: 10px;
		padding: 32px 20px calc(32px + env(safe-area-inset-bottom));
		color: var(--color-text-secondary);
		text-align: center;
	}

	.state h1 {
		margin: 2px 0 0;
		color: var(--color-text-primary);
		font-size: 19px;
		font-weight: 600;
		letter-spacing: -0.02em;
	}

	.state p {
		max-width: 42ch;
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
	}

	.state-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 4px;
	}

	.text-action {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		padding: 0 8px;
		border: 0;
		background: none;
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.text-action:hover {
		opacity: 0.8;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}

	.spin {
		display: grid;
		place-items: center;
		animation: spin 900ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 599px) {
		.toolbar {
			min-height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 8px 0 4px;
		}

		.filename {
			font-size: 12px;
		}

		.nav-arrow {
			width: 40px;
			height: 40px;
		}

		.previous {
			left: 4px;
		}

		.next {
			right: 4px;
		}

		.zoom-controls {
			left: 50%;
			transform: translateX(-50%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spin {
			animation: none;
		}
	}
</style>
