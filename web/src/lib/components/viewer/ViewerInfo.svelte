<script lang="ts">
	import { X } from '@lucide/svelte';
	import type { Asset } from '#lib/api';
	import {
		formatDateAdded,
		formatFileSize,
		formatMimeType
	} from '#lib/gallery/format';

	let { asset, onclose }: { asset: Asset; onclose: () => void } = $props();
</script>

<aside id="photo-information" class="info" aria-label="Photo information">
	<div class="head">
		<h2>Photo information</h2>
		<button
			type="button"
			class="icon-action"
			aria-label="Close information"
			onclick={onclose}
		>
			<X size={18} aria-hidden="true" />
		</button>
	</div>
	<dl>
		<div class="field">
			<dt>Filename</dt>
			<dd>{asset.filename}</dd>
		</div>
		<div class="field">
			<dt>Format</dt>
			<dd>
				{formatMimeType(asset.mime_type)} ({asset.mime_type})
			</dd>
		</div>
		<div class="field">
			<dt>File size</dt>
			<dd>{formatFileSize(asset.size)}</dd>
		</div>
		<div class="field">
			<dt>Date added</dt>
			<dd>{formatDateAdded(asset.created_at)}</dd>
		</div>
	</dl>
</aside>

<style>
	.info {
		position: fixed;
		z-index: 20;
		top: 84px;
		right: 24px;
		width: min(300px, calc(100vw - 48px));
		max-height: calc(100svh - 112px);
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 20px;
		border-radius: 14px;
		background: var(--color-elevated);
		box-shadow: 0 16px 40px #0009;
		animation: info-in var(--duration-panel) var(--ease-out) both;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.icon-action {
		display: grid;
		place-items: center;
		min-width: 44px;
		min-height: 44px;
		margin: -10px -10px -10px 0;
		padding: 0;
		border: 0;
		color: var(--color-text-secondary);
		background: none;
		cursor: pointer;
	}

	.icon-action:hover {
		color: var(--color-text-primary);
	}

	dl {
		display: grid;
		gap: 18px;
		margin: 18px 0 0;
	}

	.field {
		display: grid;
		gap: 4px;
	}

	dt {
		color: var(--color-text-secondary);
		font-size: 12px;
	}

	dd {
		margin: 0;
		font-size: 13px;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	@keyframes info-in {
		from {
			opacity: 0;
			transform: translateX(10px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	@media (max-width: 599px) {
		.info {
			top: auto;
			right: 0;
			bottom: 0;
			left: 0;
			width: auto;
			max-height: min(72svh, 520px);
			padding: 18px 20px calc(22px + env(safe-area-inset-bottom));
			border-radius: 16px 16px 0 0;
			animation-name: sheet-in;
		}
	}

	@keyframes sheet-in {
		from {
			opacity: 0;
			transform: translateY(20px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.info {
			animation: none;
		}
	}
</style>
