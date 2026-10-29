<script lang="ts">
	import { Camera, ChevronLeft, ChevronRight, CircleUserRound, Settings, Trash2, Upload, X } from '@lucide/svelte';

	let { title = 'Photos', active = 'photos', children } = $props();
	let uploadOpen = $state(false);
</script>

<div class="shell">
	<header class="topbar">
		<a class="wordmark" href="/photos" aria-label="Saefr home">saefr</a>
		<div class="mobile-title">{title}</div>
		<button class="icon-action account" aria-label="Account"><CircleUserRound size={20} /></button>
	</header>
	<aside class="sidebar" aria-label="Primary navigation">
		<nav>
			<a class:active={active === 'photos'} href="/photos"><Camera size={19} /><span>Photos</span></a>
			<a class:active={active === 'trash'} href="/trash"><Trash2 size={19} /><span>Trash</span></a>
			<a href="/settings" aria-disabled="true" onclick={(event) => event.preventDefault()}><Settings size={19} /><span>Settings</span></a>
		</nav>
	</aside>
	<main>
		<div class="mobile-heading">
			<div><p class="eyebrow">Library</p><h1>{title}</h1></div>
			{#if active === 'photos'}
				<button class="text-action" onclick={() => (uploadOpen = true)}><Upload size={17} /> Upload</button>
			{/if}
		</div>
		{@render children()}
	</main>
	<nav class="bottom-nav" aria-label="Mobile navigation">
		<a class:active={active === 'photos'} href="/photos"><Camera size={19} /><span>Photos</span></a>
		<a class:active={active === 'trash'} href="/trash"><Trash2 size={19} /><span>Trash</span></a>
		<a href="/settings" aria-disabled="true" onclick={(event) => event.preventDefault()}><Settings size={19} /><span>Settings</span></a>
	</nav>
	{#if uploadOpen}
		<div class="upload-panel" role="dialog" aria-label="Upload photos">
			<div class="upload-panel-head"><strong>Upload photos</strong><button class="icon-action" aria-label="Close upload" onclick={() => (uploadOpen = false)}><X size={18} /></button></div>
			<p>Choose JPEG, PNG or WebP files up to 20 MiB.</p>
			<label class="file-picker"><Upload size={18} /> Choose files<input type="file" accept="image/jpeg,image/png,image/webp" multiple /></label>
			<div class="upload-state"><span>Ready to upload</span><span>0 files</span></div>
		</div>
	{/if}
</div>

<style>
	.shell { min-height: 100vh; background: var(--color-canvas); color: var(--color-text-primary); }
	.topbar { height: 72px; display:flex; align-items:center; justify-content:space-between; padding: 0 28px 0 30px; }
	.wordmark { color:var(--color-text-primary); font-size:20px; font-weight:600; letter-spacing:-.05em; text-decoration:none; }
	.icon-action { display:grid; place-items:center; min-width:44px; min-height:44px; color:var(--color-text-secondary); background:none; border:0; cursor:pointer; }
	.icon-action:hover, .text-action:hover, nav a:hover { color:var(--color-text-primary); }
	.account { margin-left:auto; }
	.sidebar { position:fixed; top:72px; left:0; bottom:0; width:216px; padding:28px 20px; }
	.sidebar nav, .bottom-nav { display:grid; gap:4px; }
	nav a { display:flex; align-items:center; gap:12px; min-height:44px; padding:0 12px; color:var(--color-text-secondary); text-decoration:none; transition:color .14s ease; }
	nav a.active { color:var(--color-text-primary); }
	main { margin-left:216px; padding: 26px 28px 64px; }
	.mobile-heading { display:flex; justify-content:space-between; align-items:end; margin-bottom:28px; }
	.eyebrow { color:var(--color-text-secondary); font-size:12px; margin:0 0 4px; }
	h1 { font-size:24px; line-height:1.15; margin:0; letter-spacing:-.03em; }
	.text-action { display:flex; align-items:center; gap:8px; min-height:44px; color:var(--color-text-primary); background:none; border:0; cursor:pointer; }
	.mobile-title, .bottom-nav { display:none; }
	.upload-panel { position:fixed; z-index:5; right:24px; bottom:24px; width:min(340px, calc(100vw - 32px)); padding:16px; border-radius:14px; background:var(--color-elevated); box-shadow:0 12px 30px #0008; }
	.upload-panel-head, .upload-state { display:flex; align-items:center; justify-content:space-between; }
	.upload-panel p { color:var(--color-text-secondary); font-size:13px; line-height:1.45; }
	.file-picker { display:flex; gap:8px; align-items:center; justify-content:center; min-height:44px; color:var(--color-text-primary); cursor:pointer; }
	.file-picker input { position:absolute; width:1px; height:1px; opacity:0; }
	.upload-state { margin-top:12px; color:var(--color-text-secondary); font-size:12px; }
	@media (max-width: 899px) { .sidebar { width:68px; padding:28px 12px; } .sidebar nav a { justify-content:center; padding:0; } .sidebar nav span { display:none; } main { margin-left:68px; } }
	@media (max-width: 599px) {
		.topbar { height:60px; padding:0 12px; } .wordmark { font-size:18px; } .mobile-title { display:block; font-weight:500; margin:auto; }
		.sidebar { display:none; } main { margin:0; padding:18px 10px 92px; } .mobile-heading { margin-bottom:22px; } .mobile-heading .eyebrow { display:none; }
		.bottom-nav { display:grid; grid-template-columns:repeat(3, 1fr); position:fixed; z-index:4; left:0; right:0; bottom:0; padding:6px 8px calc(6px + env(safe-area-inset-bottom)); background:var(--color-elevated); }
		.bottom-nav a { flex-direction:column; gap:2px; min-height:48px; padding:3px; font-size:11px; } .bottom-nav a.active { color:var(--color-text-primary); }
		.upload-panel { right:10px; bottom:80px; } .account { min-width:40px; }
	}
</style>
