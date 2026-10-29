<script lang="ts">
	import { ArrowLeft, ChevronRight, Settings } from '@lucide/svelte';

	let { children } = $props();

	const sections = [
		{ label: 'Account', href: '/settings/account', description: 'Identity and sign-out' },
		{ label: 'Security', href: '/settings/security', description: 'Password and access' },
		{ label: 'Sessions', href: '/settings/sessions', description: 'Active sign-ins' },
		{ label: 'Administration', href: '/settings/users', description: 'Manage users' }
	];
</script>

<svelte:head><title>Settings · Saefr Photos</title></svelte:head>

<div class="settings-shell">
	<header class="settings-header">
		<a class="back-link" href="/" aria-label="Back to photos"><ArrowLeft size={17} /> <span>Photos</span></a>
		<div class="settings-title"><Settings size={19} aria-hidden="true" /> <h1>Settings</h1></div>
	</header>

	<div class="settings-layout">
		<nav class="settings-nav" aria-label="Settings sections">
			<p class="eyebrow">Settings</p>
			{#each sections as section}
				<a href={section.href} class="settings-link" aria-current={undefined}>
					<span>{section.label}</span>
					<ChevronRight size={16} aria-hidden="true" />
					<small>{section.description}</small>
				</a>
			{/each}
		</nav>
		<main class="settings-main">
			{@render children()}
		</main>
	</div>
</div>

<style>
	.settings-shell { min-height: 100vh; padding: 0 24px 80px; background: var(--color-canvas); color: var(--color-text-primary); }
	.settings-header { display: flex; align-items: center; justify-content: space-between; min-height: 72px; max-width: 1080px; margin: 0 auto; }
	.settings-title, .back-link { display: flex; align-items: center; gap: 10px; }
	.settings-title h1 { margin: 0; font-size: 24px; letter-spacing: -.04em; }
	.back-link { min-height: 44px; color: var(--color-text-secondary); text-decoration: none; }
	.back-link:hover { color: var(--color-text-primary); }
	.settings-layout { display: grid; grid-template-columns: 200px minmax(0, 680px); gap: 72px; max-width: 1080px; margin: 36px auto 0; }
	.settings-nav { display: flex; flex-direction: column; gap: 4px; }
	.eyebrow { margin: 0 0 12px; color: var(--color-text-disabled); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
	.settings-link { position: relative; display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; min-height: 48px; padding: 8px 0; color: var(--color-text-secondary); text-decoration: none; }
	.settings-link:hover, .settings-link:focus-visible { color: var(--color-text-primary); }
	.settings-link small { grid-column: 1 / -1; color: var(--color-text-disabled); font-size: 12px; }
	.settings-main { min-width: 0; }
	@media (max-width: 899px) { .settings-shell { padding-inline: 16px; } .settings-layout { grid-template-columns: 68px minmax(0, 1fr); gap: 32px; } .settings-link small { display: none; } .settings-link span { font-size: 0; } .settings-link span::first-letter { font-size: 14px; } }
	@media (max-width: 599px) {
		.settings-shell { padding: 0 12px calc(32px + env(safe-area-inset-bottom)); }
		.settings-header { min-height: 64px; }
		.settings-title h1 { font-size: 20px; }
		.settings-layout { display: block; margin-top: 20px; }
		.settings-nav { margin-bottom: 24px; }
		.settings-nav .eyebrow { display: none; }
		.settings-link { grid-template-columns: 1fr auto; min-height: 58px; padding: 12px 0; }
		.settings-link span, .settings-link small { display: block; font-size: inherit; }
		.settings-link span { color: var(--color-text-primary); font-size: 15px; }
		.settings-link small { color: var(--color-text-secondary); font-size: 12px; }
		.settings-link :global(svg) { grid-row: 1 / span 2; grid-column: 2; align-self: center; }
		.settings-main { padding-top: 4px; }
	}
</style>
