<script lang="ts">
	import { ArrowLeft, ChevronRight, RefreshCw } from '@lucide/svelte';
	import { pendingDeletions } from '../../../lib/fixtures';
	import AnimatedList from '../../../lib/components/svelte-bits/AnimatedList.svelte';

	let selectedId = $state(pendingDeletions[0]?.id ?? '');
	const pendingNames = pendingDeletions.map((receipt) => receipt.filename);
	const selected = $derived(pendingDeletions.find((receipt) => receipt.id === selectedId) ?? pendingDeletions[0]);
</script>

<svelte:head><title>Pending deletions · Saefr</title></svelte:head>
<div class="page">
	<header><a href="/trash" aria-label="Back to Trash"><ArrowLeft size={20} /></a><div><p>Trash</p><h1>Pending deletions</h1></div></header>
	<p class="intro">These deletions need your attention. Saefr will not retry them automatically.</p>
	<section class="pending-layout" aria-label="Pending deletion receipts">
		<AnimatedList
			items={pendingNames}
			class="pending-list"
			itemClass="pending-list-item"
			onItemSelect={(item) => (selectedId = pendingDeletions.find((receipt) => receipt.filename === item)?.id ?? selectedId)}
		/>
		{#if selected}
			<article class="receipt">
				<div><h2>{selected.filename}</h2><p>Requested {selected.requested}</p><p class="status">{selected.status}</p></div>
				<div class="receipt-actions"><a href={`/trash/pending/${selected.id}`} aria-label={`View ${selected.filename} receipt`}><ChevronRight size={20} /></a><button aria-label={`Retry deletion of ${selected.filename}`}><RefreshCw size={17} /> <span>Retry</span></button></div>
			</article>
		{/if}
	</section>
</div>

<style>
	.page { min-height:100vh; padding:32px max(24px, calc((100vw - 760px)/2)); background:var(--color-canvas); color:var(--color-text-primary); } header { display:flex; align-items:center; gap:16px; margin-bottom:34px; } header a { display:grid; place-items:center; min-width:44px; min-height:44px; color:var(--color-text-secondary); } header p { color:var(--color-text-secondary); margin:0 0 4px; font-size:12px; } h1 { margin:0; font-size:24px; } .intro { color:var(--color-text-secondary); max-width:540px; line-height:1.5; margin-bottom:26px; } .pending-layout { display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr); gap:28px; align-items:start; } :global(.pending-list) { width:auto; } :global(.pending-list-item) { margin-bottom:8px; } :global(.pending-list-item > div) { border-radius:10px; background:var(--color-elevated); color:var(--color-text-primary); } .receipt { display:flex; justify-content:space-between; align-items:center; gap:20px; padding:18px 0; } .receipt h2 { font-size:15px; margin:0 0 6px; } .receipt p { color:var(--color-text-secondary); font-size:12px; margin:4px 0; } .receipt .status { color:var(--color-danger); } .receipt-actions { display:flex; align-items:center; gap:10px; } .receipt-actions a, .receipt-actions button { display:flex; align-items:center; gap:7px; min-height:44px; border:0; background:none; color:var(--color-text-primary); text-decoration:none; cursor:pointer; padding:0 8px; } .receipt-actions button { color:var(--color-text-secondary); } .receipt-actions button:hover { color:var(--color-text-primary); } @media (max-width:599px) { .page { padding:18px 12px 40px; } .pending-layout { grid-template-columns:1fr; } .receipt { align-items:flex-start; } .receipt-actions { flex-direction:column-reverse; gap:0; } }
</style>
