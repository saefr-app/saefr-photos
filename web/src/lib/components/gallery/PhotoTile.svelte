<script lang="ts">
	import { ImageOff } from '@lucide/svelte';
	import { assetThumbnailPath, type AssetPageItem } from '#lib/api';
	import { gallery } from '#lib/gallery/gallery.svelte';

	let { item }: { item: AssetPageItem } = $props();

	let failed = $state(false);

	const href = $derived(`/photos/${encodeURIComponent(item.id)}`);

	function open(event: MouseEvent) {
		// Modifier and alternate-button activations leave this page; remembering
		// its scroll snapshot or a viewer return would be wrong for those.
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		gallery.markOpenedFromGallery();
	}
</script>

<a class="tile" {href} aria-label={`Open ${item.filename}`} onclick={open}>
	{#if failed}
		<span class="placeholder" aria-hidden="true">
			<ImageOff size={20} />
		</span>
	{:else}
		<img
			src={assetThumbnailPath(item.id)}
			alt=""
			loading="lazy"
			decoding="async"
			onerror={() => (failed = true)}
		/>
	{/if}
</a>

<style>
	.tile {
		display: block;
		overflow: hidden;
		aspect-ratio: 1;
		border-radius: 3px;
		background: var(--color-input);
	}

	img,
	.placeholder {
		display: block;
		width: 100%;
		height: 100%;
	}

	img {
		object-fit: cover;
		transition: filter var(--duration-fast) var(--ease-out);
	}

	.placeholder {
		display: grid;
		place-items: center;
		color: var(--color-text-disabled);
	}

	.tile:hover img,
	.tile:focus-visible img {
		filter: brightness(1.12);
	}

	.tile:focus-visible {
		outline-offset: -2px;
	}

	@media (prefers-reduced-motion: reduce) {
		img {
			transition: none;
		}
	}
</style>
