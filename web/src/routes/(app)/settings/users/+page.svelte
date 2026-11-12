<script lang="ts">
	import { KeyRound, UserRound } from '@lucide/svelte';
	import { session } from '#lib/session';

	const isAdmin = $derived(session.isAdmin);
</script>

<section class="page">
	<div class="page-heading">
		<p class="eyebrow">Administration</p>
		<h2>Users</h2>
		<p>Manage ordinary library accounts.</p>
	</div>

	{#if isAdmin}
		<div class="notice-panel">
			<div class="notice-icon" aria-hidden="true"><UserRound size={22} /></div>
			<h3>User management isn't available in this build yet.</h3>
			<p>No user records are shown here. This screen will connect to the existing administration API in a later step.</p>
		</div>
	{:else}
		<div class="notice-panel">
			<div class="notice-icon" aria-hidden="true"><KeyRound size={22} /></div>
			<h3>Administration is available to administrators only.</h3>
			<p>Your account does not have access to user management.</p>
			<a class="text-action" href="/settings/account">Go to Account</a>
		</div>
	{/if}
</section>

<style>
	.page { max-width: 680px; } .page-heading h2 { margin: 0; font-size: 24px; letter-spacing: -.04em; } .page-heading p:last-child { margin: 8px 0 0; color: var(--color-text-secondary); line-height: 1.6; } .eyebrow { margin: 0 0 10px; color: var(--color-text-disabled); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
	.notice-panel { display: grid; justify-items: start; gap: 8px; margin-top: 40px; max-width: 520px; }
	.notice-icon { display: grid; width: 44px; height: 44px; place-items: center; margin-bottom: 8px; border-radius: 12px; background: var(--color-input); color: var(--color-text-secondary); }
	.notice-panel h3 { margin: 0; font-size: 17px; line-height: 1.35; }
	.notice-panel p { margin: 0; color: var(--color-text-secondary); line-height: 1.6; }
	.text-action { display: inline-flex; min-height: 44px; align-items: center; margin-top: 8px; color: var(--color-text-primary); text-decoration: none; }
	.text-action:hover { opacity: .72; }
</style>
