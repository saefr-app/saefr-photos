<script lang="ts">
	import { ArrowLeft, CircleAlert, RefreshCw } from '@lucide/svelte';
	import { page } from '$app/state';
	import { pendingDeletions } from '../../../../lib/fixtures';
	const receipt = pendingDeletions.find((item) => item.id === page.params.id) ?? pendingDeletions[0];
	let retried = $state(false);
</script>

<svelte:head><title>{receipt.filename} · Pending deletion</title></svelte:head>
<div class="page">
	<header><a href="/trash/pending" aria-label="Back to pending deletions"><ArrowLeft size={20} /></a><div><p>Pending deletion</p><h1>{receipt.filename}</h1></div></header>
	<div class="status-box"><CircleAlert size={22} /><div><strong>{retried ? 'Retry requested' : receipt.status}</strong><p>{retried ? 'We will check the receipt again. No automatic retry is scheduled.' : receipt.reason}</p></div></div>
	<dl><div><dt>Requested</dt><dd>{receipt.requested}</dd></div><div><dt>Safe reason</dt><dd>{receipt.reason}</dd></div><div><dt>Receipt status</dt><dd>{receipt.status}</dd></div></dl>
	<button class="retry" onclick={() => (retried = true)}><RefreshCw size={17} /> Retry deletion</button>
</div>

<style>
	.page { min-height:100vh; padding:32px max(24px, calc((100vw - 680px)/2)); background:var(--color-canvas); color:var(--color-text-primary); } header { display:flex; align-items:center; gap:16px; margin-bottom:38px; } header a { display:grid; place-items:center; min-width:44px; min-height:44px; color:var(--color-text-secondary); } header p { color:var(--color-text-secondary); margin:0 0 4px; font-size:12px; } h1 { font-size:22px; margin:0; overflow-wrap:anywhere; } .status-box { display:flex; gap:14px; padding:18px; border-radius:12px; background:var(--color-elevated); color:var(--color-danger); } .status-box strong { color:var(--color-text-primary); font-size:14px; } .status-box p { color:var(--color-text-secondary); line-height:1.5; margin:6px 0 0; font-size:13px; } dl { margin:28px 0; } dl div { margin:20px 0; } dt { color:var(--color-text-secondary); font-size:12px; } dd { margin:5px 0 0; font-size:14px; } .retry { display:flex; gap:8px; align-items:center; min-height:44px; color:var(--color-text-primary); border:0; background:none; cursor:pointer; padding:0; } @media (max-width:599px) { .page { padding:18px 12px; } }
</style>
