<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, KeyRound, RefreshCw, X } from '@lucide/svelte';
	import type { SessionInfo } from '#lib/api';
	import { session } from '#lib/session';

	let sessions = $state<SessionInfo[]>([]);
	let loadState = $state<'loading' | 'ready' | 'error'>('loading');
	let loadError = $state('');
	let pendingId = $state<string | null>(null);
	let actionMessage = $state('');
	let actionIsError = $state(false);

	const formatter = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	});

	function formatDate(value: string): string {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? 'Not reported' : formatter.format(date);
	}

	async function load() {
		loadState = 'loading';
		loadError = '';
		const result = await session.loadSessions();
		if (result.ok) {
			sessions = result.sessions;
			loadState = 'ready';
		} else {
			loadError = result.error.message;
			loadState = 'error';
		}
	}

	async function revoke(item: SessionInfo) {
		pendingId = item.id;
		actionMessage = '';
		actionIsError = false;
		const result = await session.revokeSession(item.id);
		pendingId = null;
		if (!result.ok) {
			actionMessage = result.error.message;
			actionIsError = true;
			return;
		}
		// Revoking the current session clears the store; the guard takes over.
		if (result.wasCurrent) return;
		actionMessage = 'Session revoked.';
		await load();
	}

	onMount(() => {
		void load();
	});
</script>

<section class="page">
	<div class="page-heading"><p class="eyebrow">Access</p><h2>Sessions</h2><p>Active sign-ins are listed with the times the server reports. Only session timing is available.</p></div>

	{#if loadState === 'loading'}
		<div class="state" role="status" aria-live="polite"><span class="spin" aria-hidden="true"><RefreshCw size={17} /></span> Loading sessions…</div>
	{:else if loadState === 'error'}
		<div class="state" role="alert">
			<p>{loadError}</p>
			<button class="text-action" onclick={load}>Try again</button>
		</div>
	{:else}
		<div class="session-list" aria-live="polite">
			{#each sessions as item (item.id)}
				<article class="session">
					<div class="session-icon"><KeyRound size={18} aria-hidden="true" /></div>
					<div class="session-copy">
						<strong>{item.current ? 'Current session' : 'Other session'}</strong>
						<span>Created {formatDate(item.createdAt)}</span>
						<span>Expires {formatDate(item.expiresAt)}</span>
					</div>
					{#if item.current}
						<span class="current"><Check size={15} aria-hidden="true" /> Active</span>
					{:else}
						<button
							class="revoke"
							onclick={() => revoke(item)}
							disabled={pendingId === item.id}
						>
							<X size={15} aria-hidden="true" />
							{pendingId === item.id ? 'Revoking…' : 'Revoke'}
						</button>
					{/if}
				</article>
			{:else}
				<p class="empty">No active sessions to show.</p>
			{/each}
		</div>
		{#if actionMessage}
			<p class:error={actionIsError} class="status" role={actionIsError ? 'alert' : 'status'}>{actionMessage}</p>
		{/if}
	{/if}
</section>

<style>
	.page { max-width: 680px; } .page-heading h2 { margin: 0; font-size: 24px; letter-spacing: -.04em; } .page-heading p:last-child { margin: 8px 0 0; color: var(--color-text-secondary); line-height: 1.6; } .eyebrow { margin: 0 0 10px; color: var(--color-text-disabled); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
	.state { display: flex; align-items: center; gap: 10px; margin-top: 40px; color: var(--color-text-secondary); line-height: 1.6; } .state p { margin: 0; } .spin { animation: spin 900ms linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
	.session-list { display: grid; gap: 8px; margin-top: 40px; } .session { display: grid; grid-template-columns: 44px 1fr auto; gap: 12px; align-items: center; min-height: 72px; } .session-icon { display: grid; width: 40px; height: 40px; place-items: center; border-radius: 12px; background: var(--color-input); color: var(--color-text-secondary); } .session-copy { display: grid; gap: 4px; min-width: 0; } .session-copy span { color: var(--color-text-secondary); font-size: 12px; } .current, .revoke { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; white-space: nowrap; } .current { color: var(--color-brand-highlight); } .revoke { min-height: 44px; border: 0; background: transparent; padding: 8px 0; color: var(--color-danger); font: inherit; font-size: 12px; cursor: pointer; } .revoke:hover { opacity: .72; } .revoke:disabled { opacity: .45; cursor: default; } .text-action { display: inline-flex; min-height: 44px; align-items: center; border: 0; background: transparent; padding: 8px 0; color: var(--color-text-primary); font: inherit; cursor: pointer; } .empty, .status { color: var(--color-text-secondary); line-height: 1.6; } .status { margin-top: 28px; } .status.error { color: var(--color-danger); }
	@media (max-width: 599px) { .session { grid-template-columns: 40px 1fr; gap: 10px; } .revoke, .current { grid-column: 2; justify-self: start; } }
	@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
