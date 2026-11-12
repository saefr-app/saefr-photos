<script lang="ts">
	import { LogOut, UserRound } from '@lucide/svelte';
	let signedOut = $state(false);
	let showConfirm = $state(false);
</script>

<section class="page">
	<div class="page-heading"><p class="eyebrow">Your account</p><h2>Account</h2><p>Review the identity used for this private library.</p></div>
	<div class="identity">
		<div class="avatar" aria-hidden="true"><UserRound size={22} /></div>
		<div><strong>sahil</strong><span>Administrator</span></div>
	</div>
	<dl class="details">
		<div><dt>Username</dt><dd>sahil</dd></div>
		<div><dt>Role</dt><dd>Administrator</dd></div>
		<div><dt>Session</dt><dd>Current browser session</dd></div>
	</dl>
	<div class="action-area">
		{#if signedOut}<p class="status" role="status">Signed out locally. Sign-in will be connected when the API is enabled.</p>
		{:else}<button class="text-action danger" onclick={() => (showConfirm = true)}><LogOut size={17} /> Sign out</button>{/if}
	</div>
</section>

{#if showConfirm}
	<div class="dialog-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && (showConfirm = false)}>
		<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="signout-title">
			<h3 id="signout-title">Sign out?</h3><p>This synthetic fixture will end the current session on this screen.</p>
			<div class="dialog-actions"><button class="text-action" onclick={() => (showConfirm = false)}>Cancel</button><button class="text-action danger" onclick={() => { signedOut = true; showConfirm = false; }}>Sign out</button></div>
		</div>
	</div>
{/if}

<style>
	.page { max-width: 620px; } .page-heading h2 { margin: 0; font-size: 24px; letter-spacing: -.04em; } .page-heading p:last-child { margin: 8px 0 0; color: var(--color-text-secondary); line-height: 1.6; } .eyebrow { margin: 0 0 10px; color: var(--color-text-disabled); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
	.identity { display: flex; align-items: center; gap: 14px; margin: 40px 0; } .avatar { display: grid; width: 48px; height: 48px; place-items: center; border-radius: 14px; background: var(--color-input); color: var(--color-text-secondary); } .identity div:last-child { display: grid; gap: 4px; } .identity span, dt { color: var(--color-text-secondary); font-size: 13px; }
	.details { display: grid; gap: 24px; margin: 0; } .details div { display: grid; gap: 5px; } dt { font-size: 12px; color: var(--color-text-disabled); } dd { margin: 0; }
	.action-area { margin-top: 42px; } .text-action { display: inline-flex; min-height: 44px; align-items: center; gap: 8px; border: 0; background: transparent; padding: 8px 0; color: var(--color-text-primary); cursor: pointer; } .text-action:hover { opacity: .72; } .danger { color: var(--color-danger); } .status { color: var(--color-text-secondary); line-height: 1.5; }
	.dialog-backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 20px; background: #0008; } .dialog { width: min(100%, 400px); border-radius: 16px; background: var(--color-elevated); padding: 24px; box-shadow: 0 18px 50px #0008; } .dialog h3 { margin: 0; font-size: 18px; } .dialog p { color: var(--color-text-secondary); line-height: 1.6; } .dialog-actions { display: flex; justify-content: flex-end; gap: 20px; margin-top: 24px; }
</style>
