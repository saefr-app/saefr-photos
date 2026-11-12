<script lang="ts">
	import { ImageOff, Loader, RotateCcw, Trash2 } from '@lucide/svelte';
	import { assetTrashThumbnailPath, type TrashPageItem } from '#lib/api';

	let {
		item,
		busy = false,
		error = '',
		onrestore,
		ondelete
	}: {
		item: TrashPageItem;
		busy?: boolean;
		error?: string;
		onrestore: () => void;
		ondelete: () => void;
	} = $props();

	let failed = $state(false);
</script>

<article class="tile-wrap" aria-busy={busy}>
	<div class="tile">
		{#if failed}
			<span class="placeholder" aria-hidden="true">
				<ImageOff size={20} />
			</span>
		{:else}
			<img
				src={assetTrashThumbnailPath(item.id)}
				alt=""
				loading="lazy"
				decoding="async"
				onerror={() => (failed = true)}
			/>
		{/if}
	</div>

	<div class="meta">
		<span class="name" title={item.filename}>{item.filename}</span>
		<div class="actions">
			<button
				type="button"
				class="icon-action"
				aria-label={`Restore ${item.filename}`}
				disabled={busy}
				onclick={onrestore}
			>
				{#if busy}
					<span class="spin" aria-hidden="true"><Loader size={16} /></span>
				{:else}
					<RotateCcw size={16} aria-hidden="true" />
				{/if}
			</button>
			<button
				type="button"
				class="icon-action danger"
				aria-label={`Permanently delete ${item.filename}`}
				disabled={busy}
				onclick={ondelete}
			>
				<Trash2 size={16} aria-hidden="true" />
			</button>
		</div>
	</div>

	{#if error}
		<p class="item-error" role="alert">{error}</p>
	{/if}
	{#if busy}
		<span class="sr-only" role="status">Working on {item.filename}…</span>
	{/if}
</article>

<style>
	.tile-wrap {
		min-width: 0;
	}

	.tile {
		display: block;
		aspect-ratio: 1;
		overflow: hidden;
		border-radius: 3px;
		background: var(--color-input);
	}

	img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		filter: saturate(0.72);
		transition: filter var(--duration-fast) var(--ease-out);
	}

	.tile:hover img,
	.tile:focus-within img {
		filter: saturate(0.9) brightness(1.1);
	}

	.placeholder {
		display: grid;
		place-items: center;
		width: 100%;
		height: 100%;
		color: var(--color-text-disabled);
	}

	.meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 2px;
		padding: 4px 0 2px;
		color: var(--color-text-secondary);
		font-size: 11px;
	}

	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.actions {
		display: flex;
		flex: 0 0 auto;
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

	.icon-action.danger:hover:not(:disabled) {
		color: var(--color-danger);
	}

	.icon-action:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.item-error {
		margin: 0 0 6px;
		color: var(--color-danger);
		font-size: 12px;
		line-height: 1.4;
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

	@media (prefers-reduced-motion: reduce) {
		img {
			transition: none;
		}

		.spin {
			animation: none;
		}
	}
</style>
