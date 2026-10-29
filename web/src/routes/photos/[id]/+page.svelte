<script lang="ts">
	import { ArrowLeft, ArrowRight, Download, Info, MoreHorizontal, X } from '@lucide/svelte';
	import { page } from '$app/state';
	import { photos } from '../../../lib/fixtures';

	const photo = photos.find((item) => item.id === page.params.id) ?? photos[0];
	let infoOpen = $state(false);
	let menuOpen = $state(false);
	let zoom = $state(1);
	const index = photos.findIndex((item) => item.id === photo.id);
	const previous = photos[index - 1];
	const next = photos[index + 1];
</script>

<svelte:window onkeydown={(event) => {
	if (event.key === 'Escape') history.back();
	if (event.key === '+' || event.key === '=') zoom = Math.min(2, zoom + 0.25);
	if (event.key === '-') zoom = Math.max(1, zoom - 0.25);
}} />

<div class="viewer">
	<header class="toolbar">
		<a class="icon-action" href="/photos" aria-label="Close viewer"><X size={21} /></a>
		<span class="filename">{photo.filename}</span>
		<div class="toolbar-actions">
			<button class="icon-action" aria-label="Photo information" onclick={() => (infoOpen = !infoOpen)}><Info size={20} /></button>
			<a class="icon-action" href={photo.color} download={photo.filename} aria-label="Download original"><Download size={20} /></a>
			<button class="icon-action" aria-label="More actions" onclick={() => (menuOpen = !menuOpen)}><MoreHorizontal size={20} /></button>
		</div>
		{#if menuOpen}<div class="menu"><button onclick={() => (menuOpen = false)}>Move to Trash</button><span>Fixture action only</span></div>{/if}
	</header>
	<div class="photo-stage">
		{#if previous}<a class="nav-arrow previous" href={`/photos/${previous.id}`} aria-label="Previous photo"><ArrowLeft size={22} /></a>{/if}
		<img class="hero-image" src={photo.color} alt={photo.filename} style={`transform:scale(${zoom})`} />
		{#if next}<a class="nav-arrow next" href={`/photos/${next.id}`} aria-label="Next photo"><ArrowRight size={22} /></a>{/if}
	</div>
	<div class="zoom-controls" aria-label="Zoom controls"><button onclick={() => (zoom = Math.max(1, zoom - .25))}>−</button><span>{Math.round(zoom * 100)}%</span><button onclick={() => (zoom = Math.min(2, zoom + .25))}>+</button></div>
	{#if infoOpen}
		<aside class="info-panel" aria-label="Photo information">
			<div class="info-head"><h2>Photo information</h2><button class="icon-action" aria-label="Close information" onclick={() => (infoOpen = false)}><X size={18} /></button></div>
			<dl><dt>Filename</dt><dd>{photo.filename}</dd><dt>Format</dt><dd>{photo.mime}</dd><dt>File size</dt><dd>{photo.size}</dd><dt>Date added</dt><dd>{photo.added}</dd></dl>
		</aside>
	{/if}
</div>

<style>
	.viewer { min-height:100vh; background:var(--color-viewer); color:var(--color-text-primary); overflow:hidden; }
	.toolbar { height:72px; display:flex; align-items:center; padding:0 24px; gap:14px; position:relative; } .icon-action { display:grid; place-items:center; min-width:44px; min-height:44px; border:0; background:none; color:var(--color-text-secondary); cursor:pointer; text-decoration:none; } .icon-action:hover { color:var(--color-text-primary); }
	.filename { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:45vw; } .toolbar-actions { display:flex; margin-left:auto; }
	.menu { position:absolute; right:24px; top:62px; z-index:2; width:180px; padding:8px; background:var(--color-elevated); border-radius:12px; box-shadow:0 12px 30px #0008; } .menu button { width:100%; border:0; background:none; color:var(--color-danger); text-align:left; padding:12px; cursor:pointer; } .menu span { display:block; padding:0 12px 8px; color:var(--color-text-disabled); font-size:11px; }
	.photo-stage { height:calc(100vh - 128px); display:flex; align-items:center; justify-content:center; position:relative; padding:24px 80px; } .hero-image { max-width:calc(100vw - 160px); max-height:calc(100vh - 180px); object-fit:contain; transition:transform .16s ease; }
	.nav-arrow { position:absolute; display:grid; place-items:center; width:48px; height:48px; color:var(--color-text-secondary); background:#090b0b88; border-radius:50%; } .nav-arrow:hover { color:var(--color-text-primary); } .previous { left:24px; } .next { right:24px; }
	.zoom-controls { position:fixed; bottom:18px; left:24px; display:flex; align-items:center; gap:8px; color:var(--color-text-secondary); } .zoom-controls button { border:0; background:none; color:var(--color-text-primary); font-size:22px; width:36px; height:36px; cursor:pointer; } .zoom-controls span { font-size:12px; min-width:38px; text-align:center; }
	.info-panel { position:fixed; right:24px; top:88px; width:280px; padding:20px; border-radius:14px; background:var(--color-elevated); box-shadow:0 12px 30px #0008; } .info-head { display:flex; justify-content:space-between; align-items:center; } h2 { font-size:16px; margin:0; } dl { margin:22px 0 0; } dt { color:var(--color-text-secondary); font-size:12px; margin-top:14px; } dd { margin:4px 0 0; font-size:13px; overflow-wrap:anywhere; }
	@media (max-width:599px) { .toolbar { height:60px; padding:0 8px; } .photo-stage { height:calc(100vh - 112px); padding:16px 42px; } .hero-image { max-width:calc(100vw - 84px); max-height:calc(100vh - 180px); } .previous { left:4px; } .next { right:4px; } .info-panel { left:8px; right:8px; top:auto; bottom:8px; width:auto; } .zoom-controls { bottom:14px; left:50%; transform:translateX(-50%); } }
</style>
