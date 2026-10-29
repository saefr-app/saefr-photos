<script lang="ts">
	import { Check, RotateCcw, Trash2 } from '@lucide/svelte';
	import GalleryShell from '../../lib/components/GalleryShell.svelte';
	import { trashedPhotos } from '../../lib/fixtures';
	import SwipeToast from '../../lib/components/svelte-bits/SwipeToast.svelte';

	let confirmId = $state<string | null>(null);
	let restored = $state<string[]>([]);
	let toast = $state('');
	const visible = $derived(trashedPhotos.filter((photo) => !restored.includes(photo.id)));

	function restore(id: string) {
		restored = [...restored, id];
		toast = 'Photo restored to Photos';
		setTimeout(() => (toast = ''), 2600);
	}
</script>

<GalleryShell title="Trash" active="trash">
	<div class="trash-intro"><div><p class="hint">Items here are shown as thumbnails only.</p><p class="pending-link"><a href="/trash/pending">Pending deletions</a></p></div></div>
	{#if visible.length}
		<div class="grid">
			{#each visible as photo}
				<article class="tile-wrap">
					<a class="tile" href={`/trash/pending/${photo.id}`} aria-label={`Open ${photo.filename} in Trash`}><img src={photo.color} alt="" loading="lazy" /></a>
					<div class="tile-actions"><span>{photo.filename}</span><div><button aria-label={`Restore ${photo.filename}`} onclick={() => restore(photo.id)}><RotateCcw size={16} /></button><button class="danger" aria-label={`Permanently delete ${photo.filename}`} onclick={() => (confirmId = photo.id)}><Trash2 size={16} /></button></div></div>
				</article>
			{/each}
		</div>
	{:else}
		<div class="empty"><Check size={24} /><h2>Trash is empty</h2><p>Restored photos return to your library.</p></div>
	{/if}
	{#if confirmId}
		<div class="backdrop" role="presentation">
			<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
				<h2 id="delete-title">Delete permanently?</h2><p>This removes the photo from Trash. This action cannot be undone.</p>
				<div class="dialog-actions"><button onclick={() => (confirmId = null)}>Cancel</button><button class="delete" onclick={() => { if (confirmId) restore(confirmId); confirmId = null; }}>Delete permanently</button></div>
			</div>
		</div>
	{/if}
	<SwipeToast
		open={Boolean(toast)}
		title={toast}
		description="The synthetic library state has been updated."
		onClose={() => (toast = '')}
		duration={2600}
		fuse="bottom"
	/>
</GalleryShell>

<style>
	.trash-intro { margin:-4px 0 24px; } .hint { margin:0; color:var(--color-text-secondary); font-size:13px; } .pending-link { margin:8px 0 0; } a { color:var(--color-text-primary); text-underline-offset:3px; }
	.grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:4px; } .tile-wrap { min-width:0; } .tile { display:block; aspect-ratio:1; overflow:hidden; background:var(--color-input); border-radius:3px; } .tile img { width:100%; height:100%; display:block; object-fit:cover; filter:saturate(.72); } .tile:hover img { filter:saturate(.9) brightness(1.1); }
	.tile-actions { display:flex; align-items:center; justify-content:space-between; gap:4px; padding:7px 2px; color:var(--color-text-secondary); font-size:11px; } .tile-actions span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .tile-actions div { display:flex; } .tile-actions button { min-width:34px; min-height:34px; border:0; background:none; color:var(--color-text-secondary); cursor:pointer; } .tile-actions button:hover { color:var(--color-text-primary); } .tile-actions .danger { color:var(--color-danger); }
	.empty { display:grid; place-items:center; padding:100px 20px; color:var(--color-text-secondary); text-align:center; } .empty h2 { color:var(--color-text-primary); font-size:17px; margin:14px 0 4px; } .empty p { margin:0; }
	.backdrop { position:fixed; z-index:8; inset:0; display:grid; place-items:center; padding:20px; background:#0009; } .dialog { width:min(420px,100%); padding:24px; border-radius:16px; background:var(--color-elevated); box-shadow:0 18px 50px #000b; } .dialog h2 { margin:0; font-size:18px; } .dialog p { color:var(--color-text-secondary); line-height:1.5; } .dialog-actions { display:flex; justify-content:flex-end; gap:12px; margin-top:24px; } .dialog-actions button { min-height:44px; border:0; background:none; color:var(--color-text-primary); cursor:pointer; padding:0 8px; } .dialog-actions .delete { color:var(--color-danger); }
	@media (max-width:899px) { .grid { grid-template-columns:repeat(4,minmax(0,1fr)); } } @media (max-width:599px) { .grid { grid-template-columns:repeat(3,minmax(0,1fr)); } } @media (max-width:360px) { .grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
</style>
