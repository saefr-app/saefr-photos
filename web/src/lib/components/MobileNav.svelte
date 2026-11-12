<script lang="ts">
	import { Camera, Settings, Trash2 } from '@lucide/svelte';

	let { active }: { active: 'photos' | 'trash' | 'settings' } = $props();

	const items = [
		{ key: 'photos', label: 'Photos', href: '/photos', icon: Camera },
		{ key: 'trash', label: 'Trash', href: '/trash', icon: Trash2 },
		{ key: 'settings', label: 'Settings', href: '/settings/account', icon: Settings }
	] as const;
</script>

<nav class="mobile-nav" aria-label="Primary navigation">
	{#each items as item}
		{@const Icon = item.icon}
		<a
			href={item.href}
			class:active={active === item.key}
			aria-current={active === item.key ? 'page' : undefined}
		>
			<Icon size={20} aria-hidden="true" />
			<span>{item.label}</span>
		</a>
	{/each}
</nav>

<style>
	.mobile-nav {
		display: none;
	}

	@media (max-width: 599px) {
		.mobile-nav {
			position: fixed;
			z-index: 30;
			right: 0;
			bottom: 0;
			left: 0;
			display: grid;
			grid-template-columns: repeat(3, 1fr);
			padding: 4px 8px calc(4px + env(safe-area-inset-bottom));
			background: var(--color-canvas);
		}

		.mobile-nav a {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 3px;
			min-height: 52px;
			color: var(--color-text-secondary);
			font-size: 11px;
			letter-spacing: 0.01em;
			text-decoration: none;
		}

		.mobile-nav a.active {
			color: var(--color-text-primary);
		}

		.mobile-nav a:focus-visible {
			outline: 2px solid var(--color-focus);
			outline-offset: -2px;
			border-radius: 8px;
		}
	}
</style>
