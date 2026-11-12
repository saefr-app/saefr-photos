<script lang="ts">
	import { ArrowLeft, RefreshCw } from '@lucide/svelte';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import {
		ApiRequestError,
		getDeletion,
		retryDeletion,
		type ApiError,
		type DeletionReceipt
	} from '#lib/api';
	import GalleryShell from '#lib/components/GalleryShell.svelte';
	import {
		formatDeletionReason,
		isCompleted
	} from '#lib/deletions/format';
	import { toast } from '#lib/feedback/toast.svelte';
	import { formatDateAdded } from '#lib/gallery/format';
	import { session } from '#lib/session';

	type LoadStatus = 'loading' | 'ready' | 'error' | 'not-found';

	let receipt = $state<DeletionReceipt | null>(null);
	let status = $state<LoadStatus>('loading');
	let loadError = $state<ApiError | null>(null);
	let retryBusy = $state(false);
	let retryError = $state('');

	let requestEpoch = 0;

	function errorOf(caught: unknown): ApiError {
		if (caught instanceof ApiRequestError) return caught.api;
		return {
			status: 0,
			message: 'Something went wrong. Try again in a moment.',
			kind: 'network'
		};
	}

	async function load(id: string): Promise<void> {
		const epoch = ++requestEpoch;
		if (!receipt) status = 'loading';
		loadError = null;
		retryError = '';

		try {
			const fresh = await getDeletion(id);
			if (epoch !== requestEpoch) return;
			receipt = fresh;
			status = 'ready';
		} catch (caught) {
			if (epoch !== requestEpoch) return;
			const api = errorOf(caught);
			if (api.status === 401) {
				session.expire();
				return;
			}
			if (api.status === 400 || api.status === 404) {
				receipt = null;
				status = 'not-found';
				return;
			}
			loadError = api;
			status = receipt ? 'ready' : 'error';
		}
	}

	async function retryReceipt(): Promise<void> {
		const current = receipt;
		if (!current || retryBusy || isCompleted(current)) return;
		retryBusy = true;
		retryError = '';

		try {
			const result = await retryDeletion(current.asset_id);
			const updated = result.receipt ?? current;
			receipt = updated;

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
				receipt = null;
				status = 'not-found';
				return;
			}
			if (api.status === 0) {
				retryError =
					'Could not reach Saefr to retry. The receipt status is unchanged.';
				return;
			}
			retryError = api.message;
		} finally {
			retryBusy = false;
		}
	}

	// SvelteKit can reuse this component when only the receipt id changes, so
	// load from the current param rather than a one-shot mount callback.
	$effect(() => {
		const id = page.params.id ?? '';
		if (!id) {
			status = 'not-found';
			return;
		}
		untrack(() => void load(id));
	});
</script>

<svelte:head>
	<title>{receipt ? `Receipt ${receipt.asset_id}` : 'Deletion receipt'} · Saefr</title>
</svelte:head>

<GalleryShell title="Deletion receipt" active="trash">
	<p class="back">
		<a href="/trash/pending">
			<ArrowLeft size={16} aria-hidden="true" />
			<span>Pending deletions</span>
		</a>
	</p>

	{#if status === 'not-found'}
		<div class="state" role="status">
			<h2>Receipt not found</h2>
			<p>This deletion receipt is not available in your account.</p>
			<a class="text-link" href="/trash/pending">Back to pending deletions</a>
		</div>
	{:else if status === 'error'}
		<div class="state" role="alert">
			<h2>Receipt could not be loaded</h2>
			<p>{loadError?.message ?? 'Try again in a moment.'}</p>
			<button
				type="button"
				class="text-action"
				onclick={() => void load(page.params.id ?? '')}
			>
				<RefreshCw size={15} aria-hidden="true" />
				<span>Retry</span>
			</button>
		</div>
	{:else if !receipt}
		<div class="state" role="status">
			<p>Loading receipt…</p>
		</div>
	{:else}
		<div class="status-box" data-status={receipt.status}>
			<strong>{isCompleted(receipt) ? 'Completed' : 'Pending'}</strong>
			<p>
				{isCompleted(receipt)
					? 'Storage confirmed this permanent deletion.'
					: 'Storage has not confirmed completion. Saefr does not retry this automatically; use Retry when you want to try again.'}
			</p>
		</div>

		<dl>
			<div>
				<dt>Receipt</dt>
				<dd class="identity">{receipt.asset_id}</dd>
			</div>
			<div>
				<dt>Requested</dt>
				<dd>{formatDateAdded(receipt.requested_at)}</dd>
			</div>
			<div>
				<dt>Completed</dt>
				<dd>
					{receipt.completed_at
						? formatDateAdded(receipt.completed_at)
						: 'Not completed'}
				</dd>
			</div>
			<div>
				<dt>Safe reason</dt>
				<dd>{formatDeletionReason(receipt.last_error_code)}</dd>
			</div>
		</dl>

		{#if retryError}
			<p class="retry-error" role="alert">{retryError}</p>
		{/if}

		{#if !isCompleted(receipt)}
			<button
				type="button"
				class="text-action retry"
				disabled={retryBusy}
				aria-busy={retryBusy}
				onclick={() => void retryReceipt()}
			>
				<RefreshCw size={16} aria-hidden="true" />
				<span>{retryBusy ? 'Retrying…' : 'Retry deletion'}</span>
			</button>
		{/if}
	{/if}
</GalleryShell>

<style>
	.back {
		margin: -4px 0 26px;
	}

	.back a,
	.text-link {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		color: var(--color-text-secondary);
		font-size: 13px;
		text-decoration: none;
	}

	.back a:hover,
	.text-link:hover {
		color: var(--color-text-primary);
	}

	.status-box {
		padding: 18px;
		border-radius: 12px;
		background: var(--color-elevated);
	}

	.status-box strong {
		color: var(--color-danger);
		font-size: 14px;
		font-weight: 600;
	}

	.status-box[data-status='completed'] strong {
		color: var(--color-text-primary);
	}

	.status-box p {
		max-width: 62ch;
		margin: 6px 0 0;
		color: var(--color-text-secondary);
		font-size: 13px;
		line-height: 1.5;
	}

	dl {
		margin: 28px 0;
	}

	dl div {
		margin: 20px 0;
	}

	dt {
		color: var(--color-text-secondary);
		font-size: 12px;
	}

	dd {
		margin: 5px 0 0;
		font-size: 14px;
	}

	dd.identity {
		overflow-wrap: anywhere;
	}

	.retry-error {
		color: var(--color-danger);
		font-size: 13px;
		line-height: 1.5;
	}

	.text-action {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		padding: 0;
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

	@media (max-width: 599px) {
		.state {
			padding: 64px 16px;
		}
	}
</style>
