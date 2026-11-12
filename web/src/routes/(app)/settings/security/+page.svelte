<script lang="ts">
	import { KeyRound, LogOut } from '@lucide/svelte';
	import type { ApiError } from '#lib/api';
	import { validateNewPassword } from '#lib/auth/policy';
	import { session } from '#lib/session';

	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let formError = $state('');
	let changing = $state(false);

	let logoutOpen = $state(false);
	let loggingOut = $state(false);
	let logoutError = $state('');
	let logoutButton = $state<HTMLButtonElement | null>(null);
	let cancelLogoutButton = $state<HTMLButtonElement | null>(null);

	$effect(() => {
		if (logoutOpen) cancelLogoutButton?.focus();
	});

	function passwordFailure(error: ApiError): string {
		if (error.status === 401)
			return 'Your current password is not correct, or your session has ended. Sign in again.';
		if (error.status === 400) return 'Choose a different, stronger password.';
		if (error.status === 403) return 'You do not have permission to change this password.';
		return error.message;
	}

	async function changePassword() {
		formError = '';
		if (!currentPassword) {
			formError = 'Enter your current password.';
			return;
		}
		const policyError = validateNewPassword(newPassword);
		if (policyError) {
			formError = policyError;
			return;
		}
		if (newPassword !== confirmPassword) {
			formError = 'New password and confirmation must match.';
			return;
		}

		changing = true;
		const result = await session.changePassword(currentPassword, newPassword);
		changing = false;
		// On success the store clears and the session guard routes to login.
		if (!result.ok) formError = passwordFailure(result.error);
	}

	function closeLogout() {
		if (loggingOut) return;
		logoutOpen = false;
		logoutError = '';
		logoutButton?.focus();
	}

	function onKeydown(event: KeyboardEvent) {
		if (logoutOpen && event.key === 'Escape') {
			event.preventDefault();
			closeLogout();
		}
	}

	async function confirmLogoutAll() {
		loggingOut = true;
		logoutError = '';
		const result = await session.signOutAll();
		loggingOut = false;
		if (result.ok) logoutOpen = false;
		else logoutError = result.error.message;
	}
</script>

<svelte:window onkeydown={onKeydown} />

<section class="page">
	<div class="page-heading"><p class="eyebrow">Access</p><h2>Security</h2><p>Keep this account protected. Changes take effect immediately.</p></div>
	<section class="setting-section">
		<div class="section-title"><KeyRound size={19} /><div><h3>Change password</h3><p>A successful change ends this session and requires sign-in again.</p></div></div>
		<form onsubmit={(event) => { event.preventDefault(); changePassword(); }} class="form">
			<label>Current password<input type="password" bind:value={currentPassword} autocomplete="current-password" /></label>
			<label>New password<input type="password" bind:value={newPassword} autocomplete="new-password" aria-describedby="password-policy" /></label>
			<p id="password-policy" class="hint">Use 15–128 characters (up to 512 bytes).</p>
			<label>Confirm new password<input type="password" bind:value={confirmPassword} autocomplete="new-password" /></label>
			{#if formError}<p class="error" role="alert">{formError}</p>{/if}
			<button class="text-action primary" type="submit" disabled={changing}>{changing ? 'Changing password…' : 'Change password'}</button>
		</form>
	</section>
	<section class="setting-section">
		<div class="section-title"><LogOut size={19} /><div><h3>Log out all devices</h3><p>End every active session, including this one.</p></div></div>
		<button bind:this={logoutButton} class="text-action danger" onclick={() => (logoutOpen = true)}>Log out all devices</button>
	</section>
</section>

{#if logoutOpen}
	<div class="dialog-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && closeLogout()}>
		<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="logout-title">
			<h3 id="logout-title">Log out all devices?</h3>
			<p>All active sessions will need to sign in again. This cannot be undone.</p>
			{#if logoutError}<p class="error" role="alert">{logoutError}</p>{/if}
			<div class="dialog-actions">
				<button bind:this={cancelLogoutButton} class="text-action" onclick={closeLogout} disabled={loggingOut}>Cancel</button>
				<button class="text-action danger" onclick={confirmLogoutAll} disabled={loggingOut}>{loggingOut ? 'Logging out…' : 'Log out all'}</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.page { max-width: 620px; } .page-heading h2 { margin: 0; font-size: 24px; letter-spacing: -.04em; } .page-heading p:last-child, .section-title p { color: var(--color-text-secondary); line-height: 1.6; } .page-heading p:last-child { margin: 8px 0 0; } .eyebrow { margin: 0 0 10px; color: var(--color-text-disabled); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
	.setting-section { margin-top: 42px; } .setting-section + .setting-section { margin-top: 52px; } .section-title { display: flex; gap: 13px; } .section-title :global(svg) { flex: 0 0 auto; margin-top: 2px; color: var(--color-text-secondary); } h3 { margin: 0; font-size: 17px; } .section-title p { margin: 6px 0 0; font-size: 13px; }
	.form { display: grid; gap: 16px; margin: 26px 0 0 32px; } label { display: grid; gap: 7px; color: var(--color-text-secondary); font-size: 13px; } input { min-height: 44px; border: 0; border-radius: 9px; background: var(--color-input); padding: 10px 12px; color: var(--color-text-primary); } input:focus { outline: 2px solid var(--color-focus); outline-offset: 2px; } .hint { margin: -6px 0 0; color: var(--color-text-disabled); font-size: 12px; } .text-action { display: inline-flex; min-height: 44px; align-items: center; gap: 8px; border: 0; background: transparent; padding: 8px 0; color: var(--color-text-primary); cursor: pointer; } .text-action:hover { opacity: .72; } .text-action:disabled { opacity: .5; cursor: default; } .primary { margin-top: 4px; font-weight: 600; } .danger { color: var(--color-danger); } .error { margin: 0; color: var(--color-danger); font-size: 13px; }
	.setting-section > .text-action { margin-top: 18px; margin-left: 32px; }
	.dialog-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 20px; background: #0008; } .dialog { width: min(100%, 400px); border-radius: 16px; background: var(--color-elevated); padding: 24px; box-shadow: 0 18px 50px #0008; } .dialog h3 { margin: 0; } .dialog p { color: var(--color-text-secondary); line-height: 1.6; } .dialog-actions { display: flex; justify-content: flex-end; gap: 20px; margin-top: 24px; }
	@media (max-width: 599px) { .form, .setting-section > .text-action { margin-left: 0; } }
</style>
