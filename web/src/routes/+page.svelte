<script lang="ts">
	import {
		Archive,
		ArrowDownToLine,
		ArrowLeft,
		ArrowRight,
		ChevronDown,
		CircleHelp,
		CloudUpload,
		Download,
		Image,
		Info,
		LogOut,
		Menu,
		MoreHorizontal,
		PanelLeftClose,
		PanelLeftOpen,
		Settings,
		Trash2,
		Upload,
		UserRound,
		X
	} from '@lucide/svelte';
	import { animate, hover, press } from 'motion';

	type Photo = {
		id: number;
		name: string;
		date: string;
		image: string;
	};

	const fixtureScenes = [
		['#d8a47f', '#3e5962', 'Harbor light'],
		['#e1c49b', '#607a72', 'Weekend walk'],
		['#c4d6d0', '#718b8e', 'Quiet morning'],
		['#b97d58', '#243c4a', 'Along the coast'],
		['#d1b08a', '#536c5f', 'Soft afternoon'],
		['#9cb9bf', '#263e4d', 'Blue hour']
	];

	function fixtureImage(index: number) {
		const [start, end, label] = fixtureScenes[index % fixtureScenes.length];
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><circle cx="${160 + (index % 4) * 80}" cy="180" r="95" fill="#ffffff" opacity=".18"/><path d="M0 420 Q160 ${300 + (index % 3) * 35} 300 420 T600 390 V600 H0Z" fill="#0b171b" opacity=".4"/><text x="34" y="550" fill="#fff" opacity=".7" font-family="sans-serif" font-size="24">${label}</text></svg>`;
		return `data:image/svg+xml,${encodeURIComponent(svg)}`;
	}

	const photos: Photo[] = Array.from({ length: 18 }, (_, index) => ({
		id: index + 1,
		name: ['Harbor light', 'Weekend walk', 'Quiet morning', 'Along the coast'][index % 4],
		date: index < 9 ? 'October 2026' : 'September 2026',
		image: fixtureImage(index)
	}));

	let active = $state('Photos');
	let collapsed = $state(false);
	let selectedPhoto = $state<Photo | null>(null);
	let uploadOpen = $state(false);
	let uploadExpanded = $state(false);
	let menuOpen = $state(false);
	let toast = $state('');
	let mobileMenuOpen = $state(false);

	const navItems = [
		{ label: 'Photos', icon: Image },
		{ label: 'Trash', icon: Trash2 },
		{ label: 'Settings', icon: Settings }
	];

	function selectNav(label: string) {
		active = label;
		selectedPhoto = null;
		mobileMenuOpen = false;
	}

	function showToast(message: string) {
		toast = message;
		window.setTimeout(() => (toast = ''), 2600);
	}

	function openPhoto(photo: Photo) {
		selectedPhoto = photo;
		menuOpen = false;
	}

	function closeViewer() {
		selectedPhoto = null;
		menuOpen = false;
	}

	function movePhoto(direction: number) {
		if (!selectedPhoto) return;
		const current = photos.findIndex((photo) => photo.id === selectedPhoto?.id);
		const next = photos[(current + direction + photos.length) % photos.length];
		selectedPhoto = next;
	}

	function attachMotion(element: HTMLElement) {
		const cleanupHover = hover(element, () => {
			animate(element, { opacity: 0.72 }, { duration: 0.16 });
			return () => animate(element, { opacity: 1 }, { duration: 0.16 });
		});
		const cleanupPress = press(element, () => {
			animate(element, { scale: 0.97 }, { duration: 0.1 });
			return () => animate(element, { scale: 1 }, { duration: 0.16 });
		});
		return () => {
			cleanupHover();
			cleanupPress();
		};
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (!selectedPhoto) return;
		if (event.key === 'Escape') closeViewer();
		if (event.key === 'ArrowLeft') movePhoto(-1);
		if (event.key === 'ArrowRight') movePhoto(1);
	}}
/>

<svelte:head>
	<title>Saefr Photos</title>
	<meta
		name="description"
		content="A quiet, private photo library. Frontend foundation preview using synthetic data."
	/>
</svelte:head>

{#if selectedPhoto}
	<div class="fixed inset-0 z-50 flex flex-col bg-[#0d0f12]">
		<header class="flex items-center justify-between px-5 py-4 sm:px-8">
			<button class="action flex items-center gap-3 text-sm text-white" onclick={closeViewer}>
				<ArrowLeft size={19} />
				<span class="hidden sm:inline">Back to photos</span>
			</button>
			<div class="max-w-[42vw] truncate text-sm text-[#9ba4a1]">{selectedPhoto.name}</div>
			<div class="relative flex items-center gap-1">
				<button class="icon-action" aria-label="Photo information" onclick={() => showToast('Photo information is ready for API integration')}>
					<Info size={19} />
				</button>
				<button class="icon-action" aria-label="Download original" onclick={() => showToast('Original download will be connected in W2')}>
					<Download size={19} />
				</button>
				<button class="icon-action" aria-label="More photo actions" onclick={() => (menuOpen = !menuOpen)}>
					<MoreHorizontal size={19} />
				</button>
				{#if menuOpen}
					<div class="floating-menu right-0 top-12">
						<button class="menu-item text-[#f18b88]" onclick={() => { showToast('Move to Trash will be connected in W5'); menuOpen = false; }}>
							<Trash2 size={16} /> Move to Trash
						</button>
					</div>
				{/if}
			</div>
		</header>
		<div class="relative flex min-h-0 flex-1 items-center justify-center px-5 pb-10">
			<button class="viewer-arrow left-4 sm:left-8" aria-label="Previous photo" onclick={() => movePhoto(-1)}><ArrowLeft size={20} /></button>
			<img class="max-h-full max-w-full object-contain" src={selectedPhoto.image} alt={selectedPhoto.name} />
			<button class="viewer-arrow right-4 sm:right-8" aria-label="Next photo" onclick={() => movePhoto(1)}><ArrowRight size={20} /></button>
		</div>
	</div>
{:else}
	<div class="min-h-screen bg-[var(--color-canvas)]">
		<header class="flex h-16 items-center justify-between px-5 lg:px-8">
			<div class="flex items-center gap-3">
				<button class="icon-action lg:hidden" aria-label="Open navigation" onclick={() => (mobileMenuOpen = !mobileMenuOpen)}><Menu size={20} /></button>
				<div class="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em]">
					<span class="grid size-7 place-items-center rounded-lg bg-white text-[#090b0b]"><Image size={16} strokeWidth={2.5} /></span>
					Saefr
				</div>
			</div>
			<div class="flex items-center gap-2">
				<button class="action hidden gap-2 text-sm sm:flex" onclick={() => showToast('Help center coming soon')}><CircleHelp size={17} /> Help</button>
				<button class="icon-action" aria-label="Account" onclick={() => { active = 'Settings'; }}><UserRound size={19} /></button>
			</div>
		</header>

		<div class="flex">
			<aside class:collapsed class="sidebar hidden shrink-0 px-3 py-5 lg:block">
				<div class="mb-8 flex justify-end">
					<button class="icon-action" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onclick={() => (collapsed = !collapsed)}>
						{#if collapsed}<PanelLeftOpen size={18} />{:else}<PanelLeftClose size={18} />{/if}
					</button>
				</div>
				<nav class="space-y-2" aria-label="Primary navigation">
					{#each navItems as item}
						{@const Icon = item.icon}
						<button class:active={active === item.label} class="nav-item" title={collapsed ? item.label : undefined} onclick={() => selectNav(item.label)}>
							<Icon size={19} strokeWidth={active === item.label ? 2.2 : 1.8} />
							{#if !collapsed}<span>{item.label}</span>{/if}
						</button>
					{/each}
				</nav>
				<div class="mt-auto pt-16">
					<button class="nav-item text-[#707a76]" title={collapsed ? 'Sign out' : undefined} onclick={() => showToast('Sign out will be connected in W2')}>
						<LogOut size={18} />{#if !collapsed}<span>Sign out</span>{/if}
					</button>
				</div>
			</aside>

			<main class="min-w-0 flex-1 px-4 pb-24 sm:px-6 lg:px-8">
				<div class="mx-auto max-w-[1500px]">
					<div class="flex items-end justify-between pb-7 pt-7 sm:pt-4">
						<div>
							<p class="mb-2 text-xs uppercase tracking-[0.16em] text-[#707a76]">Your library</p>
							<h1 class="text-2xl font-semibold tracking-[-0.04em]">{active}</h1>
						</div>
						{#if active === 'Photos'}
							<button class="action flex items-center gap-2 text-sm font-medium text-white" {@attach attachMotion} onclick={() => (uploadOpen = true)}>
								<Upload size={17} /> Upload
							</button>
						{/if}
					</div>

					{#if active === 'Photos'}
						{#each ['October 2026', 'September 2026'] as month}
							<section class="mb-8">
								<h2 class="mb-3 text-[13px] font-medium text-[#9ba4a1]">Date added · {month}</h2>
								<div class="grid grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
									{#each photos.filter((photo) => photo.date === month) as photo}
										<button class="photo-tile" aria-label={`Open ${photo.name}`} onclick={() => openPhoto(photo)}>
											<img src={photo.image} alt={photo.name} loading="lazy" />
										</button>
									{/each}
								</div>
							</section>
						{/each}
					{:else if active === 'Trash'}
						<div class="empty-state">
							<div class="mb-5 grid size-14 place-items-center rounded-2xl bg-[#151a19] text-[#9ba4a1]"><Archive size={23} /></div>
							<h2 class="mb-2 text-lg font-medium">Trash is empty</h2>
							<p class="max-w-sm text-center text-sm leading-6 text-[#9ba4a1]">Photos you move to Trash will stay here until you restore or permanently delete them.</p>
						</div>
					{:else}
						<section class="settings-content">
							<div class="settings-nav">
								<p class="mb-4 text-xs uppercase tracking-[0.16em] text-[#707a76]">Settings</p>
								{#each ['Account', 'Security', 'Sessions', 'Administration'] as section}
									<button class:active-setting={section === 'Account'}>{section}</button>
								{/each}
							</div>
							<div class="max-w-xl pt-1">
								<h2 class="text-lg font-semibold">Account</h2>
								<p class="mt-2 text-sm text-[#9ba4a1]">Manage your account and sign-in preferences.</p>
								<div class="mt-8 space-y-6">
									<div><p class="text-xs text-[#707a76]">Username</p><p class="mt-1 text-sm">sahil</p></div>
									<div><p class="text-xs text-[#707a76]">Role</p><p class="mt-1 text-sm">Administrator</p></div>
									<button class="action flex items-center gap-2 text-sm text-[#f18b88]" onclick={() => showToast('Sign out will be connected in W2')}><LogOut size={17} /> Sign out</button>
								</div>
							</div>
						</section>
					{/if}
				</div>
			</main>
		</div>

		{#if uploadOpen}
			<div class="upload-panel" class:expanded={uploadExpanded}>
				<div class="flex items-center justify-between gap-5">
					<div class="flex min-w-0 items-center gap-3"><span class="grid size-9 shrink-0 place-items-center rounded-xl bg-[#23302e] text-[#5eead4]"><CloudUpload size={18} /></span><div class="min-w-0"><p class="truncate text-sm font-medium">Uploading · 3 of 5 completed</p><div class="mt-2 h-1 w-40 overflow-hidden rounded-full bg-[#303735]"><div class="h-full w-3/5 rounded-full bg-[#f5f6f6]"></div></div></div></div>
					<div class="flex items-center gap-1"><button class="icon-action" aria-label="Expand upload details" onclick={() => (uploadExpanded = !uploadExpanded)}><span class:rotate-180={uploadExpanded} class="inline-flex"><ChevronDown size={17} /></span></button><button class="icon-action" aria-label="Close upload panel" onclick={() => (uploadOpen = false)}><X size={17} /></button></div>
				</div>
				{#if uploadExpanded}<div class="mt-4 space-y-3 border-t border-white/5 pt-4 text-xs text-[#9ba4a1]"><p>beach-sunrise.jpg <span class="float-right text-white">Complete</span></p><p>harbor-walk.webp <span class="float-right text-white">Uploading</span></p><p>forest-trail.png <span class="float-right text-[#707a76]">Waiting</span></p><p class="pt-1 text-[#f18b88]">Uncertain uploads are never retried automatically.</p></div>{/if}
			</div>
		{/if}
		{#if toast}<div class="toast" role="status">{toast}</div>{/if}
	</div>
{/if}

<style>
	.action, .icon-action, .nav-item, .menu-item, .viewer-arrow, .settings-nav button { transition: opacity 160ms cubic-bezier(.22,1,.36,1), color 160ms cubic-bezier(.22,1,.36,1), background-color 160ms cubic-bezier(.22,1,.36,1), transform 160ms cubic-bezier(.22,1,.36,1); }
	.action, .icon-action { border: 0; background: transparent; color: #9ba4a1; cursor: pointer; }
	.action { min-height: 44px; padding: 8px; }
	.icon-action { display: grid; min-width: 44px; min-height: 44px; place-items: center; border-radius: 10px; }
	.icon-action:hover, .action:hover { color: #f5f6f6; }
	.sidebar { display: flex; min-height: calc(100vh - 64px); width: 220px; flex-direction: column; }
	.sidebar.collapsed { width: 68px; }
	.nav-item { display: flex; width: 100%; min-height: 44px; align-items: center; gap: 13px; border: 0; border-radius: 10px; background: transparent; padding: 8px 12px; color: #707a76; cursor: pointer; text-align: left; }
	.nav-item:hover, .nav-item.active { color: #f5f6f6; }
	.sidebar.collapsed .nav-item { justify-content: center; padding-inline: 8px; }
	.photo-tile { aspect-ratio: 1; overflow: hidden; border: 0; border-radius: 3px; background: #151a19; padding: 0; cursor: pointer; }
	.photo-tile img { width: 100%; height: 100%; object-fit: cover; transition: filter 180ms ease, transform 300ms ease; }
	.photo-tile:hover img { filter: brightness(1.12); transform: scale(1.025); }
	.floating-menu { position: absolute; z-index: 10; min-width: 180px; border-radius: 12px; background: #1a1f1e; padding: 6px; box-shadow: 0 16px 38px #0006; }
	.menu-item { display: flex; width: 100%; align-items: center; gap: 9px; border: 0; border-radius: 8px; background: transparent; padding: 10px; cursor: pointer; text-align: left; }
	.menu-item:hover { background: #ffffff0a; }
	.viewer-arrow { position: absolute; z-index: 2; display: grid; size: 44px; min-width: 44px; min-height: 44px; place-items: center; border: 0; border-radius: 50%; background: #ffffff0b; color: #f5f6f6; cursor: pointer; }
	.viewer-arrow:hover { background: #ffffff18; }
	.empty-state { display: flex; min-height: 55vh; flex-direction: column; align-items: center; justify-content: center; }
	.settings-content { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 64px; padding-top: 20px; }
	.settings-nav { display: flex; flex-direction: column; gap: 5px; }
	.settings-nav button { border: 0; background: transparent; padding: 9px 0; color: #707a76; cursor: pointer; text-align: left; }
	.settings-nav button:hover, .settings-nav button.active-setting { color: #f5f6f6; }
	.upload-panel { position: fixed; right: 24px; bottom: 24px; z-index: 20; width: 330px; border-radius: 15px; background: #1a1f1e; padding: 14px; box-shadow: 0 18px 45px #0008; }
	.toast { position: fixed; right: 24px; bottom: 28px; z-index: 30; max-width: 360px; border-radius: 12px; background: #1a1f1e; padding: 13px 16px; color: #f5f6f6; box-shadow: 0 12px 30px #0007; }
	@media (max-width: 639px) { .settings-content { display: block; padding-top: 4px; } .settings-nav { margin-bottom: 38px; } .settings-nav button { padding: 12px 0; } .upload-panel { right: 12px; bottom: 12px; left: 12px; width: auto; } .toast { right: 12px; bottom: 16px; left: 12px; text-align: center; } }
</style>
