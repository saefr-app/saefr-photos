<script lang="ts">
	import { ArrowLeft, ChevronRight, RefreshCw } from '@lucide/svelte';
	import { pendingDeletions } from '../../../lib/fixtures';
</script>

<svelte:head><title>Pending deletions · Saefr</title></svelte:head>
<div class="page">
	<header><a href="/trash" aria-label="Back to Trash"><ArrowLeft size={20} /></a><div><p>Trash</p><h1>Pending deletions</h1></div></header>
	<p class="intro">These deletions need your attention. Saefr will not retry them automatically.</p>
	<section aria-label="Pending deletion receipts">
		{#each pendingDeletions as receipt}
			<article class="receipt">
				<div><h2>{receipt.filename}</h2><p>Requested {receipt.requested}</p><p class="status">{receipt.status}</p></div>
				<div class="receipt-actions"><a href={`/trash/pending/${receipt.id}`} aria-label={`View ${receipt.filename} receipt`}><ChevronRight size={20} /></a><button aria-label={`Retry deletion of ${receipt.filename}`}><RefreshCw size={17} /> <span>Retry</span></button></div>
			</article>
		{/each}
	</section>
</div>

<style>
	.page { min-height:100vh; padding:32px max(24px, calc((100vw - 760px)/2)); background:var(--color-canvas); color:var(--color-text-primary); } header { display:flex; align-items:center; gap:16px; margin-bottom:34px; } header a { display:grid; place-items:center; min-width:44px; min-height:44px; color:var(--color-text-secondary); } header p { color:var(--color-text-secondary); margin:0 0 4px; font-size:12px; } h1 { margin:0; font-size:24px; } .intro { color:var(--color-text-secondary); max-width:540px; line-height:1.5; margin-bottom:26px; } .receipt { display:flex; justify-content:space-between; align-items:center; gap:20px; padding:18px 0; } .receipt h2 { font-size:15px; margin:0 0 6px; } .receipt p { color:var(--color-text-secondary); font-size:12px; margin:4px 0; } .receipt .status { color:var(--color-danger); } .receipt-actions { display:flex; align-items:center; gap:10px; } .receipt-actions a, .receipt-actions button { display:flex; align-items:center; gap:7px; min-height:44px; border:0; background:none; color:var(--color-text-primary); text-decoration:none; cursor:pointer; padding:0 8px; } .receipt-actions button { color:var(--color-text-secondary); } .receipt-actions button:hover { color:var(--color-text-primary); } @media (max-width:599px) { .page { padding:18px 12px 40px; } .receipt { align-items:flex-start; } .receipt-actions { flex-direction:column-reverse; gap:0; } }
</style>
