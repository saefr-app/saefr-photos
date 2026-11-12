<script lang="ts">
	import { Image as ImageIcon, ImageOff, RefreshCw, Upload } from '@lucide/svelte';
	import { onMount, tick } from 'svelte';
	import GalleryShell from '#lib/components/GalleryShell.svelte';
	import PhotoTile from '#lib/components/gallery/PhotoTile.svelte';
	import { gallery } from '#lib/gallery/gallery.svelte';
	import { groupAssetsByMonth } from '#lib/gallery/groups';
	import { session } from '#lib/session';
	import { upload } from '#lib/upload/upload.svelte';

	const groups = $derived(groupAssetsByMonth(gallery.items));
	const assetsAvailable = $derived.by(() => {
		const state = session.state;
		return state.status !== 'authenticated' || state.assetsAvailable;
	});
	const canLoadMore = $derived(
		gallery.status === 'ready' && gallery.nextCursor !== null
	);

	let sentinel = $state<HTMLDivElement | null>(null);
	let observer: IntersectionObserver | null = null;
	// Nested dragenter/dragleave events are balanced with a counter so the
	// overlay does not flicker as the pointer crosses gallery tiles.
	let dragDepth = $state(0);
	const draggingFiles = $derived(dragDepth > 0);

	function hasFilePayload(event: DragEvent): boolean {
		return event.dataTransfer?.types.includes('Files') ?? false;
	}

	function onDragEnter(event: DragEvent) {
		if (!hasFilePayload(event)) return;
		event.preventDefault();
		dragDepth += 1;
	}

	function onDragOver(event: DragEvent) {
		if (!hasFilePayload(event)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	}

	function onDragLeave(event: DragEvent) {
		event.preventDefault();
		dragDepth = Math.max(0, dragDepth - 1);
	}

	function onDrop(event: DragEvent) {
		if (hasFilePayload(event)) event.preventDefault();
		dragDepth = 0;
		const files = event.dataTransfer?.files;
		if (files && files.length > 0) upload.addFiles(files);
	}

	function nextFrame(): Promise<void> {
		return new Promise((resolve) => requestAnimationFrame(() => resolve()));
	}

	onMount(() => {
		if (!assetsAvailable) return;

		let disposed = false;

		// The gallery reuses its owner-scoped cache when this mount is the
		// return from the viewer; every other mount starts a fresh first page.
		const returned = gallery.consumeReturnedFromGallery();
		const restoring =
			returned && gallery.belongsToCurrentUser && gallery.hasLoaded;
		const restoreY = gallery.scrollY;

		// SvelteKit may scroll the outgoing page to the top while mounting. Keep
		// that transient position out of the remembered gallery offset.
		let suppressScroll = restoring;

		if (!restoring) void gallery.reload();

		function onScroll() {
			if (suppressScroll) return;
			gallery.recordScroll(window.scrollY);
		}
		window.addEventListener('scroll', onScroll, { passive: true });

		if (restoring) {
			void (async () => {
				await tick();
				await nextFrame();
				await nextFrame();
				if (disposed) return;
				window.scrollTo(0, restoreY);
				await nextFrame();
				suppressScroll = false;
			})();
		}

		if (sentinel) {
			observer = new IntersectionObserver(
				(entries) => {
					if (disposed) return;
					if (entries.some((entry) => entry.isIntersecting))
						void gallery.loadMore();
				},
				{ rootMargin: '900px 0px' }
			);
			observer.observe(sentinel);
		}

		return () => {
			disposed = true;
			window.removeEventListener('scroll', onScroll);
			observer?.disconnect();
			observer = null;
		};
	});

	// An observer callback only fires when intersection changes. Re-arm it after
	// each page so a sentinel that never left the generous margin keeps loading;
	// a pagination error waits for the explicit Retry button instead.
	$effect(() => {
		if (gallery.status !== 'ready') return;
		if (gallery.nextCursor === null) return;
		if (gallery.loadingMore || gallery.loadMoreError !== null) return;
		// Depend on the appended page even if the cursor text did not change.
		void gallery.items.length;
		if (!observer || !sentinel) return;
		observer.unobserve(sentinel);
		observer.observe(sentinel);
	});
</script>

<svelte:head><title>Photos · Saefr</title></svelte:head>

<svelte:window
	ondragenter={onDragEnter}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
/>

<GalleryShell>
	{#if !assetsAvailable}
		<div class="state" role="status">
			<ImageOff size={26} aria-hidden="true" />
			<h2>Photos unavailable</h2>
			<p>This account does not have access to the photo library.</p>
		</div>
	{:else if !gallery.hasLoaded && (gallery.status === 'idle' || gallery.status === 'loading')}
		<div class="grid skeleton" aria-busy="true" role="status">
			<span class="sr-only">Loading photos…</span>
			{#each Array(15) as _, index (index)}
				<div class="skeleton-tile" aria-hidden="true"></div>
			{/each}
		</div>
	{:else if gallery.status === 'error'}
		<div class="state" role="alert">
			<ImageOff size={26} aria-hidden="true" />
			<h2>Photos could not be loaded</h2>
			<p>{gallery.error?.message ?? 'Try again in a moment.'}</p>
			<button
				type="button"
				class="text-action"
				onclick={() => void gallery.reload()}
			>
				<RefreshCw size={15} aria-hidden="true" />
				<span>Retry</span>
			</button>
		</div>
	{:else if gallery.status === 'ready' && gallery.items.length === 0}
		<div class="state">
			<ImageIcon size={26} aria-hidden="true" />
			<h2>No photos yet</h2>
			<p>Photos in this library will appear here.</p>
		</div>
	{:else}
		{#each groups as group (group.key)}
			<section class="photo-group" aria-labelledby={`group-${group.key}`}>
				<h2 id={`group-${group.key}`}>{group.label}</h2>
				<div class="grid">
					{#each group.items as item (item.id)}
						<PhotoTile {item} />
					{/each}
				</div>
			</section>
		{/each}
	{/if}

	<div bind:this={sentinel} class="sentinel" aria-hidden="true"></div>

	{#if canLoadMore}
		<div class="pagination">
			{#if gallery.loadingMore}
				<p role="status">Loading more photos…</p>
			{:else if gallery.loadMoreError}
				<div class="notice" role="alert">
					<span>{gallery.loadMoreError.message}</span>
					<button
						type="button"
						class="text-action"
						onclick={() => void gallery.loadMore()}
					>
						<RefreshCw size={15} aria-hidden="true" />
						<span>Retry</span>
					</button>
				</div>
			{:else}
				<button
					type="button"
					class="text-action"
					onclick={() => void gallery.loadMore()}
				>
					Load more
				</button>
			{/if}
		</div>
	{/if}

	{#if draggingFiles}
		<div class="drop-overlay" role="status" aria-live="polite">
			<div class="drop-copy">
				<Upload size={28} aria-hidden="true" />
				<p>Drop photos to upload</p>
				<span>JPEG, PNG or WebP · up to 20 MiB</span>
			</div>
		</div>
	{/if}
</GalleryShell>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 4px;
	}

	.photo-group {
		margin: 0 0 30px;
	}

	h2 {
		margin: 0 0 10px;
		color: var(--color-text-secondary);
		font-size: 13px;
		font-weight: 500;
	}

	.skeleton-tile {
		aspect-ratio: 1;
		border-radius: 3px;
		background: var(--color-input);
	}

	.state {
		display: grid;
		justify-items: center;
		gap: 10px;
		padding: 84px 20px;
		color: var(--color-text-secondary);
		text-align: center;
	}

	.state h2 {
		margin: 0;
		color: var(--color-text-primary);
		font-size: 17px;
		font-weight: 600;
	}

	.state p {
		max-width: 38ch;
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
	}

	.sentinel {
		height: 1px;
	}

	.drop-overlay {
		position: fixed;
		z-index: 60;
		inset: 0;
		display: grid;
		place-items: center;
		background: rgba(9, 11, 11, 0.62);
		backdrop-filter: blur(2px);
		pointer-events: none;
	}

	.drop-copy {
		display: grid;
		justify-items: center;
		gap: 8px;
		padding: 32px;
		color: var(--color-text-primary);
		text-align: center;
	}

	.drop-copy p {
		margin: 0;
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.drop-copy span {
		color: var(--color-text-secondary);
		font-size: 12px;
	}

	.pagination {
		display: flex;
		justify-content: center;
		padding: 8px 0 4px;
	}

	.pagination p {
		margin: 0;
		color: var(--color-text-secondary);
		font-size: 13px;
	}

	.notice {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		width: 100%;
		color: var(--color-danger);
		font-size: 13px;
	}

	.text-action {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		padding: 0 4px;
		border: 0;
		color: var(--color-text-primary);
		background: none;
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

	@media (max-width: 899px) {
		.grid {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}

	@media (max-width: 599px) {
		.grid {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}

		.state {
			padding: 64px 16px;
		}
	}

	@media (max-width: 360px) {
		.grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
