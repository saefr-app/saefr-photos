<script lang="ts">
	import { ArrowRight, Eye, EyeOff, KeyRound, LoaderCircle } from '@lucide/svelte';
	import { goto } from '$app/navigation';

	type FormState = 'idle' | 'invalid' | 'loading' | 'failure' | 'limited' | 'unavailable' | 'success';

	let username = $state('');
	let password = $state('');
	let showPassword = $state(false);
	let formState = $state<FormState>('idle');
	let message = $state('');

	const fieldError = $derived(formState === 'invalid' ? {
		username: username.trim() ? '' : 'Enter your username.',
		password: password ? '' : 'Enter your password.'
	} : { username: '', password: '' });

	async function signIn() {
		formState = 'idle';
		message = '';

		if (!username.trim() || !password) {
			formState = 'invalid';
			message = 'Check the highlighted fields and try again.';
			return;
		}

		formState = 'loading';
		await new Promise((resolve) => setTimeout(resolve, 650));

		// Local fixtures keep this screen demonstrable without contacting the API.
		if (username.trim().toLowerCase() === 'offline') {
			formState = 'unavailable';
			message = 'Saefr is temporarily unavailable. Try again in a moment.';
			return;
		}
		if (username.trim().toLowerCase() === 'limited') {
			formState = 'limited';
			message = 'Too many sign-in attempts. Please wait a minute before trying again.';
			return;
		}
		if (password === 'wrong') {
			formState = 'failure';
			message = 'That username and password combination was not recognised.';
			return;
		}
		if (username.trim().toLowerCase() === 'forced-change') {
			formState = 'success';
			message = 'Sign-in successful. You need to choose a new password before continuing.';
			await new Promise((resolve) => setTimeout(resolve, 500));
			await goto('/change-password?forced=1');
			return;
		}

		formState = 'success';
		message = 'Sign-in successful. Opening your library…';
	}
</script>

<svelte:head>
	<title>Sign in · Saefr</title>
	<meta name="description" content="Sign in to your private Saefr library." />
</svelte:head>

<main class="auth-page">
	<section class="auth-content" aria-labelledby="login-title">
		<div class="brand" aria-label="Saefr">
			<span class="brand-mark" aria-hidden="true">S</span>
			<span>Saefr</span>
		</div>

		<header class="intro">
			<p class="eyebrow">Private photo library</p>
			<h1 id="login-title">Welcome back</h1>
			<p>Sign in to continue to your private library.</p>
		</header>

		<form class="auth-form" onsubmit={(event) => { event.preventDefault(); signIn(); }} novalidate>
			<div class="field">
				<label for="username">Username</label>
				<input
					id="username"
					name="username"
					type="text"
					autocomplete="username"
					bind:value={username}
					aria-invalid={Boolean(fieldError.username)}
					aria-describedby={fieldError.username ? 'username-error' : undefined}
					placeholder="Your username"
				/>
				{#if fieldError.username}<p class="field-error" id="username-error">{fieldError.username}</p>{/if}
			</div>

			<div class="field">
				<label for="password">Password</label>
				<div class="password-wrap">
					<input
						id="password"
						name="password"
						type={showPassword ? 'text' : 'password'}
						autocomplete="current-password"
						bind:value={password}
						aria-invalid={Boolean(fieldError.password)}
						aria-describedby={fieldError.password ? 'password-error' : undefined}
						placeholder="Your password"
					/>
					<button
						class="icon-button"
						type="button"
						aria-label={showPassword ? 'Hide password' : 'Show password'}
						aria-pressed={showPassword}
						onclick={() => (showPassword = !showPassword)}
					>
						{#if showPassword}<EyeOff size={18} strokeWidth={1.8} />{:else}<Eye size={18} strokeWidth={1.8} />{/if}
					</button>
				</div>
				{#if fieldError.password}<p class="field-error" id="password-error">{fieldError.password}</p>{/if}
			</div>

			{#if message}
				<p class:success={formState === 'success'} class:warning={formState === 'limited'} class="form-message" role={formState === 'failure' || formState === 'unavailable' || formState === 'limited' ? 'alert' : 'status'} aria-live="polite">
					{message}
				</p>
			{/if}

			<button class="submit-button" type="submit" disabled={formState === 'loading' || formState === 'success'}>
				{#if formState === 'loading'}
					<LoaderCircle class="spin" size={18} aria-hidden="true" />
					<span>Checking…</span>
				{:else}
					<span>Sign in</span>
					<ArrowRight size={18} aria-hidden="true" />
				{/if}
			</button>
		</form>

		<p class="fixture-hint"><KeyRound size={14} aria-hidden="true" /> UI preview only · use <strong>forced-change</strong> to preview the required password change.</p>
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
	input { width: 100%; height: 46px; border: 0; border-radius: 9px; padding: 0 14px; color: var(--color-text-primary); background: var(--color-input); outline: none; transition: background 160ms ease, box-shadow 160ms ease; }
	input::placeholder { color: var(--color-text-secondary); opacity: .8; }
	input:focus { background: #252b2a; box-shadow: 0 0 0 2px var(--color-focus); }
	input[aria-invalid='true'] { box-shadow: 0 0 0 1px var(--color-danger); }
	.password-wrap { position: relative; }
	.password-wrap input { padding-right: 50px; }
	.icon-button { position: absolute; top: 1px; right: 1px; display: grid; place-items: center; width: 44px; height: 44px; border: 0; color: var(--color-text-secondary); background: transparent; cursor: pointer; }
	.icon-button:hover { color: var(--color-text-primary); }
	.field-error, .form-message { margin: 0; font-size: 12px; line-height: 1.45; }
	.field-error { color: var(--color-danger); }
	.form-message { color: var(--color-danger); }
	.form-message.success { color: var(--color-text-secondary); }
	.form-message.warning { color: var(--color-brand-highlight); }
	.submit-button { display: flex; align-items: center; justify-content: center; gap: 9px; min-height: 46px; margin-top: 4px; border: 0; border-radius: 9px; color: var(--color-canvas); background: var(--color-text-primary); font-weight: 600; cursor: pointer; transition: opacity 160ms ease; }
	.submit-button:hover:not(:disabled) { opacity: .82; }
	.submit-button:disabled { color: var(--color-text-disabled); background: var(--color-input); cursor: wait; }
	:global(.spin) { animation: spin 900ms linear infinite; }
	.fixture-hint { display: flex; align-items: flex-start; gap: 6px; margin: 28px 0 0; color: var(--color-text-disabled); font-size: 11px; line-height: 1.5; }
	.fixture-hint strong { color: var(--color-text-secondary); font-weight: 500; }
	@keyframes spin { to { transform: rotate(360deg); } }
	@media (max-width: 480px) { .auth-page { padding: 24px 16px; } .intro { margin-top: 44px; } }
</style>
