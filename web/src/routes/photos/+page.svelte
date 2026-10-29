<script lang="ts">
	import { RefreshCw, Upload } from '@lucide/svelte';
	import GalleryShell from '../../lib/components/GalleryShell.svelte';
	import { photos } from '../../lib/fixtures';

	let showError = $state(false);
	const groups = [...new Set(photos.map((photo) => photo.added))];
</script>

<GalleryShell>
	<div class="page-actions">
		<div><p class="hint">Date added</p><p class="date-label">October 2026</p></div>
		<button class="text-action" onclick={() => (showError = !showError)}><Upload size={17} /> Upload</button>
	</div>
	{#if showError}
		<div class="notice" role="status"><span>Some photos could not be loaded. Your local library is still available.</span><button onclick={() => (showError = false)}><RefreshCw size={15} /> Retry</button></div>
	{/if}
	{#each groups as group}
		<section class="group" aria-labelledby={group}>
			<h2 id={group}>Date added · {group}</h2>
			<div class="grid">
				{#each photos.filter((photo) => photo.added === group) as photo}
					<a class="tile" href={`/photos/${photo.id}`} aria-label={`Open ${photo.filename}`}>
						<img src={photo.color} alt="" loading="lazy" />
					</a>
				{/each}
			</div>
		</section>
	{/each}
	<div class="upload-summary" aria-live="polite">Ready to upload · Choose files above</div>
</GalleryShell>

<style>
	.page-actions { display:flex; align-items:center; justify-content:space-between; margin: -4px 0 24px; }
	.hint { color:var(--color-text-secondary); font-size:12px; margin:0 0 3px; } .date-label { margin:0; color:var(--color-text-primary); font-size:14px; }
	.text-action, .notice button { display:flex; align-items:center; gap:8px; border:0; background:none; color:var(--color-text-primary); min-height:44px; cursor:pointer; }
	.notice { display:flex; justify-content:space-between; gap:16px; align-items:center; padding:12px 0; margin-bottom:22px; color:var(--color-danger); font-size:13px; }
	.notice button { color:var(--color-text-primary); white-space:nowrap; }
	.group { margin-bottom:30px; } h2 { color:var(--color-text-secondary); font-size:13px; font-weight:500; margin:0 0 10px; }
	.grid { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:4px; }
	.tile { display:block; aspect-ratio:1; overflow:hidden; background:var(--color-input); border-radius:3px; }
	.tile img { display:block; width:100%; height:100%; object-fit:cover; transition:filter .14s ease, transform .2s ease; }
	.tile:hover img, .tile:focus-visible img { filter:brightness(1.12); transform:scale(1.015); }
	.upload-summary { position:fixed; right:24px; bottom:24px; padding:12px 14px; border-radius:12px; background:var(--color-elevated); color:var(--color-text-secondary); font-size:12px; }
	@media (max-width:899px) { .grid { grid-template-columns:repeat(4, minmax(0, 1fr)); } }
	@media (max-width:599px) { .grid { grid-template-columns:repeat(3, minmax(0, 1fr)); } .upload-summary { right:10px; bottom:78px; } .notice { align-items:flex-start; } }
	@media (max-width:360px) { .grid { grid-template-columns:repeat(2, minmax(0, 1fr)); } }
</style>
