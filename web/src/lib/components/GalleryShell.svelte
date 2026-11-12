<script lang="ts">
	import {
		Camera,
		CircleUserRound,
		KeyRound,
		LogOut,
		Monitor,
		Settings,
		Trash2,
		Upload,
		UserRound,
		X
	} from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { session } from '#lib/session';
	import MobileNav from './MobileNav.svelte';
	import WarmTooltip from './svelte-bits/WarmTooltip.svelte';

	type ShellProps = {
		title?: string;
		active?: 'photos' | 'trash' | 'settings';
		children: Snippet;
	};

	let { title = 'Photos', active = 'photos', children }: ShellProps = $props();
	let uploadOpen = $state(false);
	let accountOpen = $state(false);
	let accountButton = $state<HTMLButtonElement | null>(null);
	let accountPanel = $state<HTMLDivElement | null>(null);
	let signingOut = $state(false);
	let signOutError = $state('');

	const user = $derived(session.user);
	const roleLabel = $derived(user?.role === 'admin' ? 'Administrator' : 'User');

	function closeAccount(restoreFocus = false) {
		accountOpen = false;
		if (restoreFocus) accountButton?.focus();
	}

	function toggleAccount() {
		signOutError = '';
		accountOpen = !accountOpen;
	}

	function onWindowClick(event: MouseEvent) {
		if (!accountOpen) return;
		const target = event.target;
		if (!(target instanceof Node)) return;
		if (accountButton?.contains(target) || accountPanel?.contains(target)) return;
		closeAccount();
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key === ',') {
			event.preventDefault();
			signOutError = '';
			accountOpen = true;
			accountButton?.focus();
			return;
		}
		if (accountOpen && event.key === 'Escape') {
			event.preventDefault();
			closeAccount(true);
		}
	}

	async function signOut() {
		signingOut = true;
		signOutError = '';
		const result = await session.signOut();
		signingOut = false;
		if (!result.ok) signOutError = result.error.message;
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<div class="shell">
	<header class="topbar">
		<a class="wordmark" href="/photos" aria-label="Saefr home">saefr</a>
		<div class="mobile-title">{title}</div>
		<div class="account-wrap">
			<WarmTooltip content="Account" shortcut="⌘ ," side="bottom" disabled={accountOpen}>
				<button
					bind:this={accountButton}
					class="icon-action account"
					aria-label="Account"
					aria-haspopup="true"
					aria-controls="account-menu"
					aria-expanded={accountOpen}
					onclick={toggleAccount}
				>
					<CircleUserRound size={20} />
				</button>
			</WarmTooltip>
			{#if accountOpen}
				<div bind:this={accountPanel} id="account-menu" class="account-panel">
					<div class="account-identity">
						<strong>{user?.username ?? 'Account'}</strong>
						<span>{roleLabel}</span>
					</div>
					<a href="/settings/account" onclick={() => closeAccount()}>
						<UserRound size={16} aria-hidden="true" /> Account
					</a>
					<a href="/settings/security" onclick={() => closeAccount()}>
						<KeyRound size={16} aria-hidden="true" /> Security
					</a>
					<a href="/settings/sessions" onclick={() => closeAccount()}>
						<Monitor size={16} aria-hidden="true" /> Sessions
					</a>
					{#if session.isAdmin}
						<a href="/settings/users" onclick={() => closeAccount()}>
							<UserRound size={16} aria-hidden="true" /> Administration
						</a>
					{/if}
					<button
						type="button"
						class="account-action sign-out"
						onclick={signOut}
						disabled={signingOut}
					>
						<LogOut size={16} aria-hidden="true" />
						<span>{signingOut ? 'Signing out…' : 'Sign out'}</span>
					</button>
					{#if signOutError}
						<p class="account-error" role="alert">{signOutError}</p>
					{/if}
				</div>
			{/if}
		</div>
	</header>
	<aside class="sidebar" aria-label="Primary navigation">
		<nav>
			<a class:active={active === 'photos'} href="/photos"><Camera size={19} /><span>Photos</span></a>
			<a class:active={active === 'trash'} href="/trash"><Trash2 size={19} /><span>Trash</span></a>
			<a class:active={active === 'settings'} href="/settings/account"><Settings size={19} /><span>Settings</span></a>
		</nav>
	</aside>
	<main>
		<div class="mobile-heading">
			<div><p class="eyebrow">Library</p><h1>{title}</h1></div>
			{#if active === 'photos'}
				<button class="text-action" onclick={() => (uploadOpen = true)}><Upload size={17} /> Upload</button>
			{/if}
		</div>
		{@render children()}
	</main>
	{#if uploadOpen}
		<div class="upload-panel" role="dialog" aria-label="Upload photos">
			<div class="upload-panel-head"><strong>Upload photos</strong><button class="icon-action" aria-label="Close upload" onclick={() => (uploadOpen = false)}><X size={18} /></button></div>
			<p>Choose JPEG, PNG or WebP files up to 20 MiB.</p>
			<label class="file-picker"><Upload size={18} /> Choose files<input type="file" accept="image/jpeg,image/png,image/webp" multiple /></label>
			<div class="upload-state"><span>Ready to upload</span><span>0 files</span></div>
		</div>
	{/if}
	<MobileNav {active} />
</div>

<style>
	.shell { min-height: 100vh; background: var(--color-canvas); color: var(--color-text-primary); }
	.topbar { height: 72px; display:flex; align-items:center; justify-content:space-between; padding: 0 28px 0 30px; }
	.wordmark { color:var(--color-text-primary); font-size:20px; font-weight:600; letter-spacing:-.05em; text-decoration:none; }
	.icon-action { display:grid; place-items:center; min-width:44px; min-height:44px; color:var(--color-text-secondary); background:none; border:0; cursor:pointer; }
	.icon-action:hover, .text-action:hover, nav a:hover { color:var(--color-text-primary); }
	.account-wrap { position:relative; margin-left:auto; }
	.account-panel { position:absolute; z-index:40; top:calc(100% + 4px); right:0; display:grid; gap:2px; width:min(248px, calc(100vw - 24px)); padding:8px; border-radius:12px; background:var(--color-elevated); box-shadow:0 16px 40px #0009; }
	.account-identity { display:grid; gap:3px; padding:8px 10px 10px; }
	.account-identity strong { font-size:14px; font-weight:600; overflow:hidden; text-overflow:ellipsis; }
	.account-identity span { color:var(--color-text-secondary); font-size:12px; }
	.account-panel a, .account-action { display:flex; align-items:center; gap:10px; min-height:40px; padding:8px 10px; border:0; border-radius:8px; color:var(--color-text-secondary); background:transparent; font:inherit; font-size:13px; text-align:left; text-decoration:none; cursor:pointer; }
	.account-panel a:hover, .account-action:hover { color:var(--color-text-primary); background:var(--color-input); }
	.account-panel a :global(svg), .account-action :global(svg) { flex:0 0 auto; }
	.sign-out { color:var(--color-danger); }
	.account-error { margin:4px 4px 2px; padding:0 6px; color:var(--color-danger); font-size:12px; line-height:1.45; }
	.sidebar { position:fixed; top:72px; left:0; bottom:0; width:216px; padding:28px 20px; }
	.sidebar nav { display:grid; gap:4px; width:100%; }
	nav a { display:flex; align-items:center; gap:12px; min-height:44px; width:100%; padding:0 12px; color:var(--color-text-secondary); text-decoration:none; transition:color var(--duration-ui) var(--ease-out), opacity var(--duration-ui) var(--ease-out), transform var(--duration-ui) var(--ease-out); }
	nav a :global(svg) { flex:0 0 19px; }
	nav a span { line-height:1; }
	nav a.active { color:var(--color-text-primary); }
	main { margin-left:216px; padding: 26px 28px 64px; }
	.mobile-heading { display:flex; justify-content:space-between; align-items:end; margin-bottom:28px; }
	.eyebrow { color:var(--color-text-secondary); font-size:12px; margin:0 0 4px; }
	h1 { font-size:24px; line-height:1.15; margin:0; letter-spacing:-.03em; }
	.text-action { display:flex; align-items:center; gap:8px; min-height:44px; color:var(--color-text-primary); background:none; border:0; cursor:pointer; }
	.mobile-title { display:none; }
	.upload-panel { position:fixed; z-index:35; right:24px; bottom:24px; width:min(340px, calc(100vw - 32px)); padding:16px; border-radius:14px; background:var(--color-elevated); box-shadow:0 12px 30px #0008; animation:panel-in var(--duration-panel) var(--ease-out) both; }
	.upload-panel-head, .upload-state { display:flex; align-items:center; justify-content:space-between; }
	.upload-panel p { color:var(--color-text-secondary); font-size:13px; line-height:1.45; }
	.file-picker { display:flex; gap:8px; align-items:center; justify-content:center; min-height:44px; color:var(--color-text-primary); cursor:pointer; }
	.file-picker input { position:absolute; width:1px; height:1px; opacity:0; }
	.upload-state { margin-top:12px; color:var(--color-text-secondary); font-size:12px; }
	@keyframes panel-in { from { opacity:0; transform:translateY(8px) scale(.98); } to { opacity:1; transform:translateY(0) scale(1); } }
	@media (max-width: 899px) { .sidebar { width:68px; padding:28px 12px; } .sidebar nav a { justify-content:center; padding:0; } .sidebar nav a :global(svg) { flex-basis:20px; } .sidebar nav span { display:none; } main { margin-left:68px; } }
	@media (max-width: 599px) {
		.topbar { height:60px; padding:0 12px; } .wordmark { font-size:18px; } .mobile-title { display:block; font-weight:500; margin:auto; }
		.sidebar { display:none; }
		main { margin:0; padding:18px 10px calc(88px + env(safe-area-inset-bottom)); } .mobile-heading { margin-bottom:22px; } .mobile-heading .eyebrow { display:none; }
		.upload-panel { right:10px; bottom:calc(78px + env(safe-area-inset-bottom)); } .account { min-width:44px; }
	}
	@media (prefers-reduced-motion: reduce) { .upload-panel { animation:none; } }
</style>
