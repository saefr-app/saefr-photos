<script lang="ts">
	import { Check, KeyRound, LogOut } from '@lucide/svelte';
	let passwordChanged = $state(false);
	let logoutAll = $state(false);
	let logoutDone = $state(false);
	let current = $state('');
	let next = $state('');
	let confirm = $state('');
	let error = $state('');
	function changePassword() {
		error = '';
		if (!current || !next || !confirm) error = 'Enter all three password fields.';
		else if (next.length < 8) error = 'Use at least 8 characters for the new password.';
		else if (next !== confirm) error = 'New password and confirmation must match.';
		else passwordChanged = true;
	}
</script>
<section class="page">
	<div class="page-heading"><p class="eyebrow">Access</p><h2>Security</h2><p>Keep this account protected. These controls use local fixture state only.</p></div>
	<section class="setting-section">
		<div class="section-title"><KeyRound size={19} /><div><h3>Change password</h3><p>A successful change ends this session and requires sign-in again.</p></div></div>
		{#if passwordChanged}<div class="notice" role="status"><Check size={17} /> Password changed. Please sign in again when connected.</div>
		{:else}<form onsubmit={(event) => { event.preventDefault(); changePassword(); }} class="form">
			<label>Current password<input type="password" bind:value={current} autocomplete="current-password" /></label>
			<label>New password<input type="password" bind:value={next} autocomplete="new-password" /></label>
			<label>Confirm new password<input type="password" bind:value={confirm} autocomplete="new-password" /></label>
			{#if error}<p class="error" role="alert">{error}</p>{/if}<button class="text-action primary" type="submit">Change password</button>
		</form>{/if}
	</section>
	<section class="setting-section">
		<div class="section-title"><LogOut size={19} /><div><h3>Log out all devices</h3><p>End every active session, including this one.</p></div></div>
		{#if logoutDone}<div class="notice" role="status"><Check size={17} /> All other sessions were signed out in this fixture.</div>{:else}<button class="text-action danger" onclick={() => (logoutAll = true)}>Log out all devices</button>{/if}
	</section>
</section>
{#if logoutAll}<div class="dialog-backdrop"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="logout-title"><h3 id="logout-title">Log out all devices?</h3><p>All active sessions will need to sign in again. This cannot be undone.</p><div class="dialog-actions"><button class="text-action" onclick={() => (logoutAll = false)}>Cancel</button><button class="text-action danger" onclick={() => { logoutDone = true; logoutAll = false; }}>Log out all</button></div></div></div>{/if}
<style>
	.page { max-width: 620px; } .page-heading h2 { margin: 0; font-size: 24px; letter-spacing: -.04em; } .page-heading p:last-child, .section-title p { color: var(--color-text-secondary); line-height: 1.6; } .page-heading p:last-child { margin: 8px 0 0; } .eyebrow { margin: 0 0 10px; color: var(--color-text-disabled); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
	.setting-section { margin-top: 42px; } .setting-section + .setting-section { margin-top: 52px; } .section-title { display: flex; gap: 13px; } .section-title :global(svg) { flex: 0 0 auto; margin-top: 2px; color: var(--color-text-secondary); } h3 { margin: 0; font-size: 17px; } .section-title p { margin: 6px 0 0; font-size: 13px; }
	.form { display: grid; gap: 16px; margin: 26px 0 0 32px; } label { display: grid; gap: 7px; color: var(--color-text-secondary); font-size: 13px; } input { min-height: 44px; border: 0; border-radius: 9px; background: var(--color-input); padding: 10px 12px; color: var(--color-text-primary); } input:focus { outline: 2px solid var(--color-focus); outline-offset: 2px; } .text-action { display: inline-flex; min-height: 44px; align-items: center; gap: 8px; border: 0; background: transparent; padding: 8px 0; color: var(--color-text-primary); cursor: pointer; } .text-action:hover { opacity: .72; } .primary { margin-top: 4px; font-weight: 600; } .danger { color: var(--color-danger); } .error { margin: 0; color: var(--color-danger); font-size: 13px; } .notice { display: flex; gap: 9px; align-items: center; margin: 24px 0 0 32px; color: var(--color-text-secondary); line-height: 1.5; } .notice :global(svg) { color: var(--color-brand-highlight); flex: 0 0 auto; }
	.dialog-backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 20px; background: #0008; } .dialog { width: min(100%, 400px); border-radius: 16px; background: var(--color-elevated); padding: 24px; box-shadow: 0 18px 50px #0008; } .dialog h3 { margin: 0; } .dialog p { color: var(--color-text-secondary); line-height: 1.6; } .dialog-actions { display: flex; justify-content: flex-end; gap: 20px; margin-top: 24px; }
	@media (max-width: 599px) { .form, .notice { margin-left: 0; } }
</style>
