<script lang="ts">
	import { RefreshCw } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { safeNextPath } from '#lib/auth/policy';
	import { session } from '#lib/session';

	let { children } = $props();

	let inFlight: string | null = null;

	const current = $derived(session.state);

	const redirectTarget = $derived.by((): string | null => {
		const value = current;
		if (value.status === 'loading' || value.status === 'unavailable')
			return null;

		const path = page.url.pathname;
		const search = page.url.search;

		if (value.status === 'anonymous') {
			if (path === '/login') return null;
			const next = path === '/' ? '/photos' : `${path}${search}`;
			return `/login?next=${encodeURIComponent(next)}`;
		}

		if (value.user.passwordChangeRequired)
			return path === '/change-password' ? null : '/change-password';

		if (path === '/login')
			return safeNextPath(page.url.searchParams.get('next'));

		return null;
	});

	const showLoading = $derived(current.status === 'loading' || redirectTarget !== null);

	$effect(() => {
		const target = redirectTarget;
		// The guard is the single redirect authority. A one-shot post-change
		// login path (with its notice) takes precedence over the computed one.
		const destination = session.takePendingLoginPath() ?? target;
		if (destination === null || inFlight === destination) return;
		if (destination === `${page.url.pathname}${page.url.search}`) return;
		inFlight = destination;
		void goto(destination, { replaceState: true })
			.catch(() => {
				// Another navigation superseded this redirect; nothing to recover.
			})
			.finally(() => {
				if (inFlight === destination) inFlight = null;
			});
	});
</script>

{#if showLoading}
	<div class="gate" role="status" aria-live="polite">
		<span class="brand-mark" aria-hidden="true">S</span>
		<span class="spinner" aria-hidden="true"></span>
		<p>Opening your library…</p>
	</div>
{:else if current.status === 'unavailable'}
	<div class="gate" role="alert">
		<span class="brand-mark" aria-hidden="true">S</span>
		<h1>Saefr is unavailable</h1>
		<p>{current.message}</p>
		<button type="button" onclick={() => session.retryBootstrap()}>
			<RefreshCw size={16} aria-hidden="true" />
			<span>Try again</span>
		</button>
	</div>
{:else}
	{@render children()}
{/if}

<style>
	.gate {
		display: grid;
		justify-items: center;
		align-content: center;
		gap: 14px;
		min-height: 100svh;
		padding: 32px 20px;
		background: var(--color-canvas);
		text-align: center;
	}
	.brand-mark {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border-radius: 9px;
		background: var(--color-brand);
		color: white;
		font-size: 16px;
		font-weight: 600;
	}
	.gate p {
		max-width: 34ch;
		margin: 0;
		color: var(--color-text-secondary);
		font-size: 13px;
		line-height: 1.5;
	}
	.gate h1 {
		margin: 4px 0 0;
		font-size: 20px;
		font-weight: 600;
		letter-spacing: -0.02em;
	}
	.gate button {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		margin-top: 6px;
		padding: 0 16px;
		border: 0;
		border-radius: 9px;
		color: var(--color-canvas);
		background: var(--color-text-primary);
		font-weight: 600;
		cursor: pointer;
	}
	.gate button:hover {
		opacity: 0.82;
	}
	.spinner {
		width: 18px;
		height: 18px;
		border: 2px solid var(--color-input);
		border-top-color: var(--color-text-secondary);
		border-radius: 50%;
		animation: spin 900ms linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
