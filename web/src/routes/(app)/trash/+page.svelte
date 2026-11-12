<script lang="ts">
	import { Check, RefreshCw } from '@lucide/svelte';
	import { onMount, tick } from 'svelte';
	import {
		ApiRequestError,
		lifecycleEtag,
		permanentlyDeleteAsset,
		restoreAsset,
		type ApiError,
		type TrashPageItem
	} from '#lib/api';
	import GalleryShell from '#lib/components/GalleryShell.svelte';
	import DeletePermanentlyDialog from '#lib/components/trash/DeletePermanentlyDialog.svelte';
	import TrashTile from '#lib/components/trash/TrashTile.svelte';
	import { toast } from '#lib/feedback/toast.svelte';
	import { session } from '#lib/session';
	import { trash } from '#lib/trash/trash.svelte';

	const assetsAvailable = $derived.by(() => {
		const state = session.state;
		return state.status !== 'authenticated' || state.assetsAvailable;
	});
	const canLoadMore = $derived(
		trash.status === 'ready' && trash.nextCursor !== null
	);

	let busyId = $state<string | null>(null);
	let itemErrors = $state<Record<string, string>>({});
	let deleteTarget = $state<TrashPageItem | null>(null);
	let deleteBusy = $state(false);
	let deleteError = $state('');
	let pendingNotice = $state(false);

	let sentinel = $state<HTMLDivElement | null>(null);
	let observer: IntersectionObserver | null = null;
	let gridAnchor = $state<HTMLHeadingElement | null>(null);

	/** After a row is removed, keep focus on a stable, announced heading. */
	async function focusTrashHeading(): Promise<void> {
		await tick();
		gridAnchor?.focus({ preventScroll: true });
	}

	function errorOf(caught: unknown): ApiError {
		if (caught instanceof ApiRequestError) return caught.api;
		return {
			status: 0,
			message: 'Something went wrong. Try again in a moment.',
			kind: 'network'
		};
	}

	function setItemError(id: string, message: string): void {
		itemErrors = { ...itemErrors, [id]: message };
	}

	async function restoreItem(item: TrashPageItem): Promise<void> {
		if (busyId) return;
		busyId = item.id;
		setItemError(item.id, '');

		try {
			await restoreAsset(item.id, lifecycleEtag(item.id, item.lifecycle_version));
			trash.removeItem(item.id);
			await focusTrashHeading();
			toast.show({
				title: 'Photo restored',
				description: `${item.filename} is back in Photos.`
			});
		} catch (caught) {
			const api = errorOf(caught);
			if (api.status === 401) {
				session.expire();
				return;
			}
			if (api.status === 412) {
				// The listed version is stale. Refresh and let the owner reconfirm;
				// never force a transition with an old validator.
				await trash.reload();
				toast.show({
					title: 'Trash refreshed',
					description:
						'That photo changed since it was listed. Review it and try again.'
				});
				return;
			}
			if (api.status === 404) {
				trash.removeItem(item.id);
				await focusTrashHeading();
				toast.show({
					title: 'Photo not found',
					description: 'That photo is no longer in your Trash.'
				});
				return;
			}
			setItemError(item.id, api.message);
		} finally {
			if (busyId === item.id) busyId = null;
		}
	}

	function openDelete(item: TrashPageItem): void {
		setItemError(item.id, '');
		deleteError = '';
		deleteTarget = item;
	}

	function cancelDelete(): void {
		if (deleteBusy) return;
		deleteTarget = null;
		deleteError = '';
	}

	async function confirmDelete(): Promise<void> {
		const item = deleteTarget;
		if (!item || deleteBusy) return;
		deleteBusy = true;
		deleteError = '';

		try {
			const result = await permanentlyDeleteAsset(
				item.id,
				lifecycleEtag(item.id, item.lifecycle_version)
			);
			const pending =
				result.status === 202 || result.receipt?.status === 'pending';

			trash.removeItem(item.id);
			deleteTarget = null;
			await focusTrashHeading();

			if (pending) {
				// 202 is accepted-but-unfinished. It is not a completed deletion and
				// it does not schedule an automatic retry.
				pendingNotice = true;
				toast.show({
					title: 'Deletion accepted',
					description:
						'Storage has not confirmed completion. Track it in Pending deletions.'
				});
			} else {
				toast.show({
					title: 'Photo deleted permanently',
					description: `${item.filename} was deleted.`
				});
			}
		} catch (caught) {
			const api = errorOf(caught);
			if (api.status === 401) {
				session.expire();
				return;
			}
			if (api.status === 412) {
				deleteTarget = null;
				await trash.reload();
				toast.show({
					title: 'Photo changed',
					description: 'Trash was refreshed. Review it and try again.'
				});
				return;
			}
			if (api.status === 409) {
				deleteTarget = null;
				await trash.reload();
				toast.show({
					title: 'Not in Trash',
					description:
						'That photo is no longer in Trash, so it cannot be permanently deleted from here.'
				});
				return;
			}
			if (api.status === 404) {
				deleteTarget = null;
				trash.removeItem(item.id);
				await focusTrashHeading();
				toast.show({
					title: 'Photo not found',
					description: 'That photo is no longer in your Trash.'
				});
				return;
			}
			if (api.status === 0) {
				// Network failure is not proof either way. Do not claim success and
				// tell the owner to check the authoritative receipt first.
				deleteError =
					'We could not confirm whether the deletion was accepted. Check Pending deletions before retrying.';
				return;
			}
			deleteError = api.message;
		} finally {
			deleteBusy = false;
		}
	}

	onMount(() => {
		if (!assetsAvailable) return;

		let disposed = false;
		void trash.reload();

		if (sentinel) {
			observer = new IntersectionObserver(
				(entries) => {
					if (disposed) return;
					if (entries.some((entry) => entry.isIntersecting))
						void trash.loadMore();
				},
				{ rootMargin: '900px 0px' }
			);
			observer.observe(sentinel);
		}

		return () => {
			disposed = true;
			observer?.disconnect();
			observer = null;
		};
	});

	// Re-arm the observer after each appended page so a sentinel that never left
	// the generous margin keeps loading. A pagination error waits for Retry.
	$effect(() => {
		if (trash.status !== 'ready') return;
		if (trash.nextCursor === null) return;
		if (trash.loadingMore || trash.loadMoreError !== null) return;
		void trash.items.length;
		if (!observer || !sentinel) return;
		observer.unobserve(sentinel);
		observer.observe(sentinel);
	});
</script>

<svelte:head><title>Trash · Saefr</title></svelte:head>

<GalleryShell title="Trash" active="trash">
	<h2 class="sr-only" tabindex="-1" bind:this={gridAnchor}>Trash items</h2>

	<div class="trash-intro">
		<p class="hint">
			Items here show owner-authorized Trash thumbnails. Originals are not
			exposed.
		</p>
		<p class="pending-link">
			<a href="/trash/pending">Pending deletions</a>
		</p>
	</div>

	{#if pendingNotice}
		<div class="pending-notice" role="status">
			<span>
				A permanent deletion is waiting for storage. Saefr will not retry it
				automatically.
			</span>
			<a href="/trash/pending">View Pending deletions</a>
		</div>
	{/if}

	{#if !assetsAvailable}
		<div class="state" role="status">
			<h2>Trash unavailable</h2>
			<p>This account does not have access to the photo library.</p>
		</div>
	{:else if !trash.hasLoaded && (trash.status === 'idle' || trash.status === 'loading')}
		<div class="grid skeleton" aria-busy="true" role="status">
			<span class="sr-only">Loading Trash…</span>
			{#each Array(10) as _, index (index)}
				<div class="skeleton-tile" aria-hidden="true"></div>
			{/each}
		</div>
	{:else if trash.status === 'error'}
		<div class="state" role="alert">
			<h2>Trash could not be loaded</h2>
			<p>{trash.error?.message ?? 'Try again in a moment.'}</p>
			<button
				type="button"
				class="text-action"
				onclick={() => void trash.reload()}
			>
				<RefreshCw size={15} aria-hidden="true" />
				<span>Retry</span>
			</button>
		</div>
	{:else if trash.status === 'ready' && trash.items.length === 0}
		<div class="state">
			<Check size={26} aria-hidden="true" />
			<h2>Trash is empty</h2>
			<p>Photos you move to Trash will appear here.</p>
		</div>
	{:else}
		<div class="grid">
			{#each trash.items as item (item.id)}
				<TrashTile
					{item}
					busy={busyId === item.id}
					error={itemErrors[item.id] ?? ''}
					onrestore={() => void restoreItem(item)}
					ondelete={() => openDelete(item)}
				/>
			{/each}
		</div>
	{/if}

	<div bind:this={sentinel} class="sentinel" aria-hidden="true"></div>

	{#if canLoadMore}
		<div class="pagination">
			{#if trash.loadingMore}
				<p role="status">Loading more…</p>
			{:else if trash.loadMoreError}
				<div class="notice" role="alert">
					<span>{trash.loadMoreError.message}</span>
					<button
						type="button"
						class="text-action"
						onclick={() => void trash.loadMore()}
					>
						<RefreshCw size={15} aria-hidden="true" />
						<span>Retry</span>
					</button>
				</div>
			{:else}
				<button
					type="button"
					class="text-action"
					onclick={() => void trash.loadMore()}
				>
					Load more
				</button>
			{/if}
		</div>
	{/if}
</GalleryShell>

{#if deleteTarget}
	<DeletePermanentlyDialog
		filename={deleteTarget.filename}
		busy={deleteBusy}
		error={deleteError}
		onCancel={cancelDelete}
		onConfirm={() => void confirmDelete()}
	/>
{/if}

<style>
	.trash-intro {
		margin: -4px 0 22px;
	}

	.hint {
		margin: 0;
		color: var(--color-text-secondary);
		font-size: 13px;
		line-height: 1.45;
	}

	.pending-link {
		margin: 8px 0 0;
		font-size: 13px;
	}

	.pending-link a,
	.pending-notice a {
		color: var(--color-text-primary);
		text-underline-offset: 3px;
	}

	.pending-notice {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 16px;
		margin: 0 0 20px;
		padding: 12px 14px;
		border-radius: 12px;
		background: var(--color-elevated);
		color: var(--color-text-secondary);
		font-size: 13px;
		line-height: 1.45;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 4px;
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
