<script lang="ts">
	import { ArrowRight, Eye, EyeOff, KeyRound, LoaderCircle } from '@lucide/svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';

	type FormState = 'idle' | 'invalid' | 'loading' | 'failure' | 'success';
	type Field = 'current' | 'next' | 'confirm';

	let currentPassword = $state('');
	let nextPassword = $state('');
	let confirmPassword = $state('');
	let show = $state({ current: false, next: false, confirm: false });
	let formState = $state<FormState>('idle');
	let message = $state('');

	const fields: Array<{ field: Field; label: string; inputName: string }> = [
		{ field: 'current', label: 'Current password', inputName: 'current' },
		{ field: 'next', label: 'New password', inputName: 'new' },
		{ field: 'confirm', label: 'Confirm new password', inputName: 'confirm' }
	];

	const forced = $derived(page.url.searchParams.get('forced') === '1');
	const errors = $derived(formState === 'invalid' ? {
		current: currentPassword ? '' : 'Enter your current password.',
		next: nextPassword.length >= 12 ? '' : 'Use at least 12 characters.',
		confirm: confirmPassword === nextPassword && confirmPassword ? '' : 'Passwords do not match.'
	} : { current: '', next: '', confirm: '' });

	function toggle(field: Field) {
		show[field] = !show[field];
	}

	function valueFor(field: Field): string {
		if (field === 'current') return currentPassword;
		if (field === 'next') return nextPassword;
		return confirmPassword;
	}

	function updateValue(field: Field, value: string) {
		if (field === 'current') currentPassword = value;
		if (field === 'next') nextPassword = value;
		if (field === 'confirm') confirmPassword = value;
	}

	async function changePassword() {
		formState = 'idle';
		message = '';
		if (!currentPassword || nextPassword.length < 12 || !confirmPassword || confirmPassword !== nextPassword) {
			formState = 'invalid';
			message = 'Check the highlighted fields and try again.';
			return;
		}
		formState = 'loading';
		await new Promise((resolve) => setTimeout(resolve, 700));
		if (currentPassword === 'wrong') {
			formState = 'failure';
			message = 'The current password is not correct.';
			return;
		}
		formState = 'success';
		message = 'Password changed. Your session has been cleared; sign in again to continue.';
		await new Promise((resolve) => setTimeout(resolve, 800));
		await goto('/login');
	}
</script>

<svelte:head><title>Change password · Saefr</title></svelte:head>

<main class="auth-page">
	<section class="auth-content" aria-labelledby="change-title">
		<div class="brand" aria-label="Saefr"><span class="brand-mark" aria-hidden="true">S</span><span>Saefr</span></div>
		<header class="intro">
			<p class="eyebrow">{forced ? 'Action required' : 'Account security'}</p>
			<h1 id="change-title">Choose a new password</h1>
			<p>{forced ? 'Your account requires a password change before you can open the library.' : 'Keep your private library protected with a fresh password.'}</p>
		</header>

		<form class="auth-form" onsubmit={(event) => { event.preventDefault(); changePassword(); }} novalidate>
			{#each fields as { field, label, inputName }}
				<div class="field">
					<label for={field}>{label}</label>
					<div class="password-wrap">
						<input
							id={field}
							name={inputName}
							type={show[field] ? 'text' : 'password'}
							autocomplete={field === 'current' ? 'current-password' : 'new-password'}
							value={valueFor(field)}
							oninput={(event) => updateValue(field, (event.currentTarget as HTMLInputElement).value)}
							aria-invalid={Boolean(errors[field])}
							aria-describedby={errors[field] ? `${field}-error` : undefined}
						/>
						<button class="icon-button" type="button" aria-label={show[field] ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} aria-pressed={show[field]} onclick={() => toggle(field)}>
							{#if show[field]}<EyeOff size={18} strokeWidth={1.8} />{:else}<Eye size={18} strokeWidth={1.8} />{/if}
						</button>
					</div>
					{#if errors[field]}<p class="field-error" id={`${field}-error`}>{errors[field]}</p>{/if}
				</div>
			{/each}

			<p class="requirements"><KeyRound size={14} aria-hidden="true" /> Use 12 or more characters. A successful change signs you out on this device.</p>
			{#if message}<p class:success={formState === 'success'} class="form-message" role={formState === 'failure' ? 'alert' : 'status'} aria-live="polite">{message}</p>{/if}
			<button class="submit-button" type="submit" disabled={formState === 'loading' || formState === 'success'}>
				{#if formState === 'loading'}<LoaderCircle class="spin" size={18} aria-hidden="true" /><span>Saving…</span>{:else}<span>Change password</span><ArrowRight size={18} aria-hidden="true" />{/if}
			</button>
		</form>
	</section>
</main>

<style>
	.auth-page { min-height: 100svh; display: grid; place-items: center; padding: 32px 20px; background: var(--color-canvas); }
	.auth-content { width: min(100%, 380px); }
	.brand { display: flex; align-items: center; gap: 10px; color: var(--color-text-primary); font-size: 17px; font-weight: 600; letter-spacing: -0.02em; }
	.brand-mark { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--color-brand); color: white; font-size: 16px; }
	.intro { margin: 52px 0 28px; }
	.eyebrow { margin: 0 0 12px; color: var(--color-brand-highlight); font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
	h1 { margin: 0 0 8px; font-size: 28px; font-weight: 600; letter-spacing: -0.035em; }
	.intro > p:last-child { margin: 0; color: var(--color-text-secondary); line-height: 1.5; }
	.auth-form { display: grid; gap: 20px; }
	.field { display: grid; gap: 8px; }
	label { color: var(--color-text-primary); font-size: 13px; font-weight: 500; }
	input { width: 100%; height: 46px; border: 0; border-radius: 9px; padding: 0 50px 0 14px; color: var(--color-text-primary); background: var(--color-input); outline: none; transition: background 160ms ease, box-shadow 160ms ease; }
	input:focus { background: #252b2a; box-shadow: 0 0 0 2px var(--color-focus); }
	input[aria-invalid='true'] { box-shadow: 0 0 0 1px var(--color-danger); }
	.password-wrap { position: relative; }
	.icon-button { position: absolute; top: 1px; right: 1px; display: grid; place-items: center; width: 44px; height: 44px; border: 0; color: var(--color-text-secondary); background: transparent; cursor: pointer; }
	.icon-button:hover { color: var(--color-text-primary); }
	.field-error, .form-message, .requirements { margin: 0; font-size: 12px; line-height: 1.45; }
	.field-error, .form-message { color: var(--color-danger); }
	.form-message.success { color: var(--color-text-secondary); }
	.requirements { display: flex; gap: 6px; color: var(--color-text-secondary); }
	.submit-button { display: flex; align-items: center; justify-content: center; gap: 9px; min-height: 46px; margin-top: 4px; border: 0; border-radius: 9px; color: var(--color-canvas); background: var(--color-text-primary); font-weight: 600; cursor: pointer; transition: opacity 160ms ease; }
	.submit-button:hover:not(:disabled) { opacity: .82; }
	.submit-button:disabled { color: var(--color-text-disabled); background: var(--color-input); cursor: wait; }
	:global(.spin) { animation: spin 900ms linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	@media (max-width: 480px) { .auth-page { padding: 24px 16px; } .intro { margin-top: 44px; } }
</style>
