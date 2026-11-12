<script lang="ts">
	import { ChevronRight, RefreshCw } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import {
		ApiRequestError,
		retryDeletion,
		type ApiError,
		type DeletionReceipt
	} from '#lib/api';
	import GalleryShell from '#lib/components/GalleryShell.svelte';
	import {
		formatDeletionReason,
		isCompleted
	} from '#lib/deletions/format';
	import { deletions } from '#lib/deletions/deletions.svelte';
	import { toast } from '#lib/feedback/toast.svelte';
	import { formatDateAdded } from '#lib/gallery/format';
	import { session } from '#lib/session';

	const assetsAvailable = $derived.by(() => {
		const state = session.state;
		return state.status !== 'authenticated' || state.assetsAvailable;
	});
	const canLoadMore = $derived(
		deletions.status === 'ready' && deletions.nextCursor !== null
	);

	let busyId = $state<string | null>(null);
	let itemErrors = $state<Record<string, string>>({});

	let sentinel = $state<HTMLDivElement | null>(null);
	let observer: IntersectionObserver | null = null;

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

	async function retryReceipt(receipt: DeletionReceipt): Promise<void> {
		if (busyId || isCompleted(receipt)) return;
		busyId = receipt.asset_id;
		setItemError(receipt.asset_id, '');

		try {
			const result = await retryDeletion(receipt.asset_id);
			const updated = result.receipt ?? receipt;

			deletions.applyRetry(updated, result.status);

			if (result.status === 200 || isCompleted(updated)) {
				toast.show({
					title: 'Deletion completed',
					description: 'Storage confirmed the deletion.'
				});
			} else {
				toast.show({
					title: 'Still pending',
					description:
						'Storage has not completed this deletion. Saefr will not retry automatically.'
				});
			}
		} catch (caught) {
			const api = errorOf(caught);
			if (api.status === 401) {
				session.expire();
				return;
			}
			if (api.status === 404) {
				deletions.removeItem(receipt.asset_id);
				toast.show({
					title: 'Receipt not found',
					description: 'That deletion receipt is no longer available.'
				});
				return;
			}
			if (api.status === 0) {
				setItemError(
					receipt.asset_id,
					'Could not reach Saefr to retry. The receipt status is unchanged.'
				);
				return;
			}
			setItemError(receipt.asset_id, api.message);
		} finally {
			if (busyId === receipt.asset_id) busyId = null;
		}
	}

	onMount(() => {
		if (!assetsAvailable) return;

		let disposed = false;
		void deletions.reload();

		if (sentinel) {
			observer = new IntersectionObserver(
				(entries) => {
					if (disposed) return;
					if (entries.some((entry) => entry.isIntersecting))
						void deletions.loadMore();
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

	$effect(() => {
		if (deletions.status !== 'ready') return;
		if (deletions.nextCursor === null) return;
		if (deletions.loadingMore || deletions.loadMoreError !== null) return;
		void deletions.items.length;
		if (!observer || !sentinel) return;
		observer.unobserve(sentinel);
		observer.observe(sentinel);
	});
</script>

<svelte:head><title>Pending deletions · Saefr</title></svelte:head>

<GalleryShell title="Pending deletions" active="trash">
	<div class="intro">
		<p>
			These permanent deletions were accepted but storage has not confirmed
			completion. Saefr does not retry them automatically.
		</p>
		<p><a href="/trash">Back to Trash</a></p>
	</div>

	{#if !assetsAvailable}
		<div class="state" role="status">
			<h2>Pending deletions unavailable</h2>
			<p>This account does not have access to the photo library.</p>
		</div>
	{:else if !deletions.hasLoaded && (deletions.status === 'idle' || deletions.status === 'loading')}
		<div class="skeleton-list" aria-busy="true" role="status">
			<span class="sr-only">Loading pending deletions…</span>
			{#each Array(4) as _, index (index)}
				<div class="skeleton-row" aria-hidden="true"></div>
			{/each}
		</div>
	{:else if deletions.status === 'error'}
		<div class="state" role="alert">
			<h2>Pending deletions could not be loaded</h2>
			<p>{deletions.error?.message ?? 'Try again in a moment.'}</p>
			<button
				type="button"
				class="text-action"
				onclick={() => void deletions.reload()}
			>
				<RefreshCw size={15} aria-hidden="true" />
				<span>Retry</span>
			</button>
		</div>
	{:else if deletions.status === 'ready' && deletions.items.length === 0}
		<div class="state">
			<h2>No pending deletions</h2>
			<p>Accepted deletions that still need storage will appear here.</p>
		</div>
	{:else}
		<ul class="receipt-list">
			{#each deletions.items as receipt (receipt.asset_id)}
				<li class="receipt">
					<div class="receipt-main">
						<p class="receipt-id" title={receipt.asset_id}>
							{receipt.asset_id}
						</p>
						<p class="meta">
							Requested {formatDateAdded(receipt.requested_at)}
						</p>
						<p class="meta">{formatDeletionReason(receipt.last_error_code)}</p>
						<p class="status" data-status={receipt.status}>
							{isCompleted(receipt) ? 'Completed' : 'Pending'}
						</p>
						{#if itemErrors[receipt.asset_id]}
							<p class="item-error" role="alert">
								{itemErrors[receipt.asset_id]}
							</p>
						{/if}
					</div>
					<div class="receipt-actions">
						<a
							href={`/trash/pending/${encodeURIComponent(receipt.asset_id)}`}
							aria-label={`View receipt ${receipt.asset_id}`}
						>
							<ChevronRight size={20} aria-hidden="true" />
						</a>
						{#if !isCompleted(receipt)}
							<button
								type="button"
								class="text-action"
								disabled={busyId === receipt.asset_id}
								aria-busy={busyId === receipt.asset_id}
								aria-label={`Retry deletion ${receipt.asset_id}`}
								onclick={() => void retryReceipt(receipt)}
							>
								<RefreshCw size={16} aria-hidden="true" />
								<span>
									{busyId === receipt.asset_id ? 'Retrying…' : 'Retry'}
								</span>
							</button>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	<div bind:this={sentinel} class="sentinel" aria-hidden="true"></div>

	{#if canLoadMore}
		<div class="pagination">
			{#if deletions.loadingMore}
				<p role="status">Loading more…</p>
			{:else if deletions.loadMoreError}
				<div class="notice" role="alert">
					<span>{deletions.loadMoreError.message}</span>
					<button
						type="button"
						class="text-action"
						onclick={() => void deletions.loadMore()}
					>
						<RefreshCw size={15} aria-hidden="true" />
						<span>Retry</span>
					</button>
				</div>
			{:else}
				<button
					type="button"
					class="text-action"
					onclick={() => void deletions.loadMore()}
				>
					Load more
				</button>
			{/if}
		</div>
	{/if}
</GalleryShell>

<style>
	.intro {
		margin: -4px 0 24px;
		color: var(--color-text-secondary);
		font-size: 13px;
		line-height: 1.5;
	}

	.intro p {
		max-width: 60ch;
		margin: 0;
	}

	.intro p + p {
		margin-top: 8px;
	}

	.intro a {
		color: var(--color-text-primary);
		text-underline-offset: 3px;
	}

	.receipt-list {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.receipt {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
		padding: 16px 4px;
		border-bottom: 1px solid #ffffff0d;
	}

	.receipt-main {
		min-width: 0;
	}

	.receipt-id {
		margin: 0 0 6px;
		font-size: 14px;
		overflow-wrap: anywhere;
	}

	.meta {
		margin: 3px 0;
		color: var(--color-text-secondary);
		font-size: 12px;
		line-height: 1.45;
	}

	.status {
		margin: 8px 0 0;
		font-size: 12px;
		font-weight: 500;
		color: var(--color-danger);
	}

	.status[data-status='completed'] {
		color: var(--color-text-secondary);
	}

	.item-error {
		margin: 8px 0 0;
		color: var(--color-danger);
		font-size: 12px;
		line-height: 1.45;
	}

	.receipt-actions {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 8px;
	}

	.receipt-actions a {
		display: grid;
		place-items: center;
		min-width: 44px;
		min-height: 44px;
		color: var(--color-text-secondary);
	}

	.receipt-actions a:hover {
		color: var(--color-text-primary);
	}

	.skeleton-list {
		display: grid;
		gap: 10px;
	}

	.skeleton-row {
		height: 88px;
		border-radius: 12px;
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
		max-width: 42ch;
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
		padding: 12px 0 4px;
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

	.text-action:hover:not(:disabled) {
		opacity: 0.8;
	}

	.text-action:disabled {
		opacity: 0.5;
		cursor: default;
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

	@media (max-width: 599px) {
		.receipt {
			align-items: flex-start;
			gap: 10px;
			padding: 14px 0;
		}

		.receipt-actions {
			flex-direction: column;
			gap: 0;
		}

		.state {
			padding: 64px 16px;
		}
	}
</style>
