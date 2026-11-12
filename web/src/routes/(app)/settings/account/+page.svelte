<script lang="ts">
	import { LogOut, UserRound } from '@lucide/svelte';
	import { session } from '#lib/session';

	let showConfirm = $state(false);
	let signingOut = $state(false);
	let error = $state('');
	let signOutButton = $state<HTMLButtonElement | null>(null);
	let cancelButton = $state<HTMLButtonElement | null>(null);

	const user = $derived(session.user);
	const roleLabel = $derived(user?.role === 'admin' ? 'Administrator' : 'User');
	const expiryLabel = $derived.by(() => {
		if (session.state.status !== 'authenticated') return null;
		const date = new Date(session.state.session.expiresAt);
		if (Number.isNaN(date.getTime())) return null;
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(date);
	});

	$effect(() => {
		if (showConfirm) cancelButton?.focus();
	});

	function closeDialog() {
		if (signingOut) return;
		showConfirm = false;
		error = '';
		signOutButton?.focus();
	}

	function onKeydown(event: KeyboardEvent) {
		if (showConfirm && event.key === 'Escape') {
			event.preventDefault();
			closeDialog();
		}
	}

	async function confirmSignOut() {
		signingOut = true;
		error = '';
		const result = await session.signOut();
		signingOut = false;
		if (result.ok) showConfirm = false;
		else error = result.error.message;
	}
</script>

<svelte:window onkeydown={onKeydown} />

<section class="page">
	<div class="page-heading"><p class="eyebrow">Your account</p><h2>Account</h2><p>Review the identity used for this private library.</p></div>
	<div class="identity">
		<div class="avatar" aria-hidden="true"><UserRound size={22} /></div>
		<div><strong>{user?.username ?? 'Signed in'}</strong><span>{roleLabel}</span></div>
	</div>
	<dl class="details">
		<div><dt>Username</dt><dd>{user?.username ?? 'Not reported'}</dd></div>
		<div><dt>Role</dt><dd>{roleLabel}</dd></div>
		<div><dt>Session</dt><dd>This browser</dd></div>
		<div><dt>Expires</dt><dd>{expiryLabel ?? 'Not reported'}</dd></div>
	</dl>
	<div class="action-area">
		<button bind:this={signOutButton} class="text-action danger" onclick={() => (showConfirm = true)}><LogOut size={17} /> Sign out</button>
	</div>
</section>

{#if showConfirm}
	<div class="dialog-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && closeDialog()}>
		<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="signout-title">
			<h3 id="signout-title">Sign out?</h3>
			<p>This ends your session in this browser. You will need to sign in again.</p>
			{#if error}<p class="status error" role="alert">{error}</p>{/if}
			<div class="dialog-actions">
				<button bind:this={cancelButton} class="text-action" onclick={closeDialog} disabled={signingOut}>Cancel</button>
				<button class="text-action danger" onclick={confirmSignOut} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.page { max-width: 620px; } .page-heading h2 { margin: 0; font-size: 24px; letter-spacing: -.04em; } .page-heading p:last-child { margin: 8px 0 0; color: var(--color-text-secondary); line-height: 1.6; } .eyebrow { margin: 0 0 10px; color: var(--color-text-disabled); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
	.identity { display: flex; align-items: center; gap: 14px; margin: 40px 0; } .avatar { display: grid; width: 48px; height: 48px; place-items: center; border-radius: 14px; background: var(--color-input); color: var(--color-text-secondary); } .identity div:last-child { display: grid; gap: 4px; } .identity span, dt { color: var(--color-text-secondary); font-size: 13px; }
	.details { display: grid; gap: 24px; margin: 0; } .details div { display: grid; gap: 5px; } dt { font-size: 12px; color: var(--color-text-disabled); } dd { margin: 0; }
	.action-area { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-top: 42px; } .text-action { display: inline-flex; min-height: 44px; align-items: center; gap: 8px; border: 0; background: transparent; padding: 8px 0; color: var(--color-text-primary); cursor: pointer; } .text-action:hover { opacity: .72; } .text-action:disabled { opacity: .5; cursor: default; } .danger { color: var(--color-danger); } .status { margin: 0; color: var(--color-text-secondary); line-height: 1.5; } .status.error { color: var(--color-danger); }
	.dialog-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 20px; background: #0008; } .dialog { width: min(100%, 400px); border-radius: 16px; background: var(--color-elevated); padding: 24px; box-shadow: 0 18px 50px #0008; } .dialog h3 { margin: 0; font-size: 18px; } .dialog p { color: var(--color-text-secondary); line-height: 1.6; } .dialog-actions { display: flex; justify-content: flex-end; gap: 20px; margin-top: 24px; }
</style>
