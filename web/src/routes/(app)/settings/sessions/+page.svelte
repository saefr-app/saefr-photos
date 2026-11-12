<script lang="ts">
	import { Check, Monitor, Smartphone, X } from '@lucide/svelte';
	type Session = { id: number; name: string; created: string; expiry: string; current?: boolean };
	let sessions = $state<Session[]>([
		{ id: 1, name: 'Current browser session', created: 'Today, 09:14', expiry: 'Expires in 30 days', current: true },
		{ id: 2, name: 'Mobile browser session', created: 'Yesterday, 18:42', expiry: 'Expires in 29 days' },
		{ id: 3, name: 'Desktop browser session', created: 'October 21, 2026', expiry: 'Expires in 22 days' }
	]);
	let revoked = $state<number | null>(null);
	function revoke(session: Session) { sessions = sessions.filter((item) => item.id !== session.id); revoked = session.id; }
</script>
<section class="page">
	<div class="page-heading"><p class="eyebrow">Access</p><h2>Sessions</h2><p>Only session timing is shown; no device location or browser details are stored in this fixture.</p></div>
	<div class="session-list" aria-live="polite">
		{#each sessions as session}
			<article class="session">
				<div class="session-icon">{#if session.current}<Monitor size={19} />{:else}<Smartphone size={19} />{/if}</div>
				<div class="session-copy"><strong>{session.name}</strong><span>Created {session.created} · {session.expiry}</span>{#if session.current}<small>Current session</small>{/if}</div>
				{#if session.current}<span class="current"><Check size={15} /> Active</span>{:else}<button class="revoke" onclick={() => revoke(session)}><X size={15} /> Revoke</button>{/if}
			</article>
		{:else}<p class="empty">No active sessions remain. Sign in again to start a new one.</p>{/each}
	</div>
	{#if revoked}<p class="status" role="status">Session revoked. The fixture has cleared it from the list.</p>{/if}
</section>
<style>
	.page { max-width: 680px; } .page-heading h2 { margin: 0; font-size: 24px; letter-spacing: -.04em; } .page-heading p:last-child { margin: 8px 0 0; color: var(--color-text-secondary); line-height: 1.6; } .eyebrow { margin: 0 0 10px; color: var(--color-text-disabled); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
	.session-list { display: grid; gap: 8px; margin-top: 40px; } .session { display: grid; grid-template-columns: 44px 1fr auto; gap: 12px; align-items: center; min-height: 72px; } .session-icon { display: grid; width: 40px; height: 40px; place-items: center; border-radius: 12px; background: var(--color-input); color: var(--color-text-secondary); } .session-copy { display: grid; gap: 4px; min-width: 0; } .session-copy span, .session-copy small { color: var(--color-text-secondary); font-size: 12px; } .session-copy small { color: var(--color-brand-highlight); } .current, .revoke { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; white-space: nowrap; } .current { color: var(--color-text-secondary); } .revoke { min-height: 44px; border: 0; background: transparent; padding: 8px 0; color: var(--color-danger); cursor: pointer; } .revoke:hover { opacity: .72; } .empty, .status { color: var(--color-text-secondary); line-height: 1.6; } .status { margin-top: 28px; }
	@media (max-width: 599px) { .session { grid-template-columns: 40px 1fr; gap: 10px; } .revoke, .current { grid-column: 2; justify-self: start; } }
</style>
