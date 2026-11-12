<script lang="ts">
	import { onMount, tick } from 'svelte';
	import {
		LoaderCircle,
		MoreHorizontal,
		RefreshCw,
		ShieldAlert,
		UserPlus,
		UserRound
	} from '@lucide/svelte';
	import {
		ApiRequestError,
		createUser,
		DEFAULT_USERS_LIMIT,
		disableUser,
		listUsers,
		type AdminUser,
		type ApiError
	} from '#lib/api';
	import { trapTab } from '#lib/a11y/focus';
	import {
		createUserError,
		disableUserError,
		validateAddUser,
		validateDisablePassword,
		type AddUserErrors
	} from '#lib/admin/users';
	import { session } from '#lib/session';

	type LoadState = 'loading' | 'ready' | 'error' | 'restricted';

	const EMPTY_ADD_ERRORS: AddUserErrors = {
		username: '',
		initialPassword: '',
		currentPassword: ''
	};

	let loadState = $state<LoadState>('loading');
	let users = $state<AdminUser[]>([]);
	let loadError = $state('');
	let restrictedMessage = $state(
		'Administration is available to administrators only.'
	);
	let hasMore = $state(false);
	let nextOffset = $state(0);
	let loadingMore = $state(false);
	let loadMoreError = $state('');
	let notice = $state('');
	let noticeIsError = $state(false);

	// Add-user dialog
	let addOpen = $state(false);
	let adding = $state(false);
	let addButton = $state<HTMLButtonElement | null>(null);
	let addDialog = $state<HTMLDivElement | null>(null);
	let addUsername = $state('');
	let addInitialPassword = $state('');
	let addCurrentPassword = $state('');
	let addErrors = $state<AddUserErrors>({ ...EMPTY_ADD_ERRORS });
	let addFormError = $state('');

	// Disable dialog
	let disableTarget = $state<AdminUser | null>(null);
	let disabling = $state(false);
	let disablePassword = $state('');
	let disableFieldError = $state('');
	let disableFormError = $state('');
	let disableDialog = $state<HTMLDivElement | null>(null);
	let disableTrigger = $state<HTMLButtonElement | null>(null);

	// Row overflow menus
	let openMenuId = $state<string | null>(null);
	const menuButtons = new Map<string, HTMLButtonElement>();

	const canManage = $derived(session.isAdmin && loadState !== 'restricted');
	const visibleUsers = $derived(session.isAdmin ? users : []);

	function apiErrorOf(error: unknown): ApiError {
		if (error instanceof ApiRequestError) return error.api;
		return {
			status: 0,
			message: 'Something went wrong. Try again in a moment.',
			kind: 'network'
		};
	}

	function roleLabel(role: AdminUser['role']): string {
		return role === 'admin' ? 'Administrator' : 'User';
	}

	function statusLabel(status: AdminUser['status']): string {
		return status === 'active' ? 'Active' : 'Disabled';
	}

	function enterRestricted(message: string): void {
		users = [];
		openMenuId = null;
		restrictedMessage = message;
		loadState = 'restricted';
		notice = '';
		noticeIsError = false;
	}

	async function loadFirst(): Promise<void> {
		loadState = 'loading';
		loadError = '';
		loadMoreError = '';
		openMenuId = null;
		try {
			const page = await listUsers({
				limit: DEFAULT_USERS_LIMIT,
				offset: 0
			});
			users = page;
			nextOffset = page.length;
			hasMore = page.length === DEFAULT_USERS_LIMIT;
			loadState = 'ready';
		} catch (error) {
			const api = apiErrorOf(error);
			if (api.status === 401) {
				session.expire();
				return;
			}
			if (api.status === 403) {
				enterRestricted('Your account cannot manage users right now.');
				return;
			}
			loadError = api.message;
			loadState = 'error';
		}
	}

	async function loadMore(): Promise<void> {
		if (loadingMore || !hasMore) return;
		loadingMore = true;
		loadMoreError = '';
		try {
			const page = await listUsers({
				limit: DEFAULT_USERS_LIMIT,
				offset: nextOffset
			});
			const seen = new Set(users.map((user) => user.id));
			users = [...users, ...page.filter((user) => !seen.has(user.id))];
			nextOffset += page.length;
			hasMore = page.length === DEFAULT_USERS_LIMIT;
		} catch (error) {
			const api = apiErrorOf(error);
			if (api.status === 401) {
				session.expire();
				return;
			}
			if (api.status === 403) {
				enterRestricted('Your account cannot manage users right now.');
				return;
			}
			loadMoreError = api.message;
		} finally {
			loadingMore = false;
		}
	}

	onMount(() => {
		if (!session.isAdmin) {
			enterRestricted(
				'Administration is available to administrators only. Your account does not have access to user management.'
			);
			return;
		}
		void loadFirst();
	});

	$effect(() => {
		if (!addOpen) return;
		void tick().then(() => {
			addDialog?.querySelector<HTMLInputElement>('input')?.focus();
		});
	});

	$effect(() => {
		if (!disableTarget) return;
		void tick().then(() => {
			disableDialog?.querySelector<HTMLInputElement>('input')?.focus();
		});
	});

	function resetAddForm(): void {
		addUsername = '';
		addInitialPassword = '';
		addCurrentPassword = '';
		addErrors = { ...EMPTY_ADD_ERRORS };
		addFormError = '';
	}

	function openAddDialog(): void {
		resetAddForm();
		addOpen = true;
	}

	function closeAddDialog(): void {
		if (adding) return;
		addOpen = false;
		resetAddForm();
		addButton?.focus();
	}

	async function submitAdd(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		addFormError = '';
		addErrors = validateAddUser(
			addUsername,
			addInitialPassword,
			addCurrentPassword
		);
		if (
			addErrors.username ||
			addErrors.initialPassword ||
			addErrors.currentPassword
		)
			return;

		adding = true;
		try {
			await createUser(
				addUsername.trim(),
				addInitialPassword,
				addCurrentPassword
			);
			addOpen = false;
			resetAddForm();
			notice = 'User created. They must choose a new password at first sign-in.';
			noticeIsError = false;
			await loadFirst();
			addButton?.focus();
		} catch (error) {
			const api = apiErrorOf(error);
			if (api.status === 401) {
				session.expire();
				return;
			}
			if (api.status === 403) {
				addOpen = false;
				resetAddForm();
				enterRestricted('Your account cannot create users.');
				return;
			}
			if (api.status === 409) {
				addErrors = { ...addErrors, username: createUserError(api) };
				return;
			}
			addFormError = createUserError(api);
		} finally {
			adding = false;
		}
	}

	function toggleMenu(user: AdminUser, button: HTMLButtonElement): void {
		if (openMenuId === user.id) {
			openMenuId = null;
			button.focus();
			return;
		}
		menuButtons.set(user.id, button);
		openMenuId = user.id;
		void tick().then(() => {
			document
				.getElementById(`user-menu-${user.id}`)
				?.querySelector<HTMLElement>('[role="menuitem"]')
				?.focus();
		});
	}

	function closeMenu(restoreFocus = false): void {
		const id = openMenuId;
		openMenuId = null;
		if (restoreFocus && id) menuButtons.get(id)?.focus();
	}

	function onMenuKeydown(event: KeyboardEvent, user: AdminUser): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeMenu(true);
			return;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			document
				.getElementById(`user-menu-${user.id}`)
				?.querySelector<HTMLElement>('[role="menuitem"]')
				?.focus();
		}
	}

	function requestDisable(user: AdminUser): void {
		disableTrigger = menuButtons.get(user.id) ?? null;
		openMenuId = null;
		disablePassword = '';
		disableFieldError = '';
		disableFormError = '';
		disableTarget = user;
	}

	function resetDisableDialog(): void {
		disableTarget = null;
		disablePassword = '';
		disableFieldError = '';
		disableFormError = '';
	}

	function closeDisableDialog(): void {
		if (disabling) return;
		resetDisableDialog();
		disableTrigger?.focus();
	}

	async function submitDisable(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const target = disableTarget;
		if (!target) return;

		disableFormError = '';
		disableFieldError = validateDisablePassword(disablePassword);
		if (disableFieldError) return;

		disabling = true;
		try {
			await disableUser(target.id, disablePassword);
			users = users.map((user) =>
				user.id === target.id ? { ...user, status: 'disabled' } : user
			);
			resetDisableDialog();
			notice = `${target.username} was disabled. Active sessions were revoked.`;
			noticeIsError = false;
			disableTrigger?.focus();
		} catch (error) {
			const api = apiErrorOf(error);
			if (api.status === 401) {
				session.expire();
				return;
			}
			if (api.status === 403) {
				resetDisableDialog();
				enterRestricted('Your account cannot disable users.');
				return;
			}
			if (api.status === 404) {
				resetDisableDialog();
				notice = 'That account no longer exists. The list has been refreshed.';
				noticeIsError = true;
				await loadFirst();
				return;
			}
			disableFormError = disableUserError(api);
		} finally {
			disabling = false;
		}
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		if (disableTarget) {
			event.preventDefault();
			closeDisableDialog();
			return;
		}
		if (addOpen) {
			event.preventDefault();
			closeAddDialog();
			return;
		}
		if (openMenuId) {
			event.preventDefault();
			closeMenu(true);
		}
	}

	function onWindowClick(event: MouseEvent): void {
		if (!openMenuId) return;
		const target = event.target;
		if (target instanceof Element && target.closest('[data-menu-root]')) return;
		closeMenu();
	}
</script>

<svelte:window onkeydown={onWindowKeydown} onclick={onWindowClick} />

<section class="page">
	<div class="page-head">
		<div class="page-heading">
			<p class="eyebrow">Administration</p>
			<h2>Users</h2>
			<p>Manage ordinary library accounts. Roles are fixed by the server.</p>
		</div>
		{#if canManage}
			<button
				bind:this={addButton}
				class="add-user"
				type="button"
				onclick={openAddDialog}
			>
				<UserPlus size={17} aria-hidden="true" />
				<span>Add user</span>
			</button>
		{/if}
	</div>

	{#if !session.isAdmin}
		<div class="restricted" role="status">
			<div class="restricted-icon" aria-hidden="true"><ShieldAlert size={22} /></div>
			<h3>Administration is available to administrators only.</h3>
			<p>Your account does not have access to user management.</p>
			<a class="text-action" href="/settings/account">Go to Account</a>
		</div>
	{:else if loadState === 'restricted'}
		<div class="restricted" role="status">
			<div class="restricted-icon" aria-hidden="true"><ShieldAlert size={22} /></div>
			<h3>User management is restricted</h3>
			<p>{restrictedMessage}</p>
			<a class="text-action" href="/settings/account">Go to Account</a>
		</div>
	{:else if loadState === 'loading'}
		<p class="sr-only" role="status">Loading users…</p>
		<div class="user-list skeleton" aria-hidden="true">
			{#each [0, 1, 2, 3] as row (row)}
				<div class="user-row">
					<span class="glyph-skeleton"></span>
					<span class="copy-skeleton">
						<span class="line wide"></span>
						<span class="line"></span>
					</span>
				</div>
			{/each}
		</div>
	{:else if loadState === 'error'}
		<div class="state error" role="alert">
			<p>{loadError}</p>
			<button class="text-action" type="button" onclick={loadFirst}>
				<RefreshCw size={16} aria-hidden="true" /> Try again
			</button>
		</div>
	{:else}
		{#if visibleUsers.length === 0}
			<p class="empty">No user accounts to show.</p>
		{:else}
			<ul class="user-list">
				{#each visibleUsers as user (user.id)}
					<li class="user-row">
						<span class="glyph" aria-hidden="true"><UserRound size={18} /></span>
						<div class="user-copy">
							<strong>{user.username}</strong>
							<span class="meta">
								<span>{roleLabel(user.role)}</span>
								<span aria-hidden="true">·</span>
								<span class:disabled={user.status === 'disabled'}>{statusLabel(user.status)}</span>
							</span>
						</div>
						{#if user.status === 'active'}
							<div
								class="row-actions"
								data-menu-root
								onfocusout={(event) => {
									const next = event.relatedTarget;
									if (
										openMenuId === user.id &&
										(!(next instanceof Node) || !event.currentTarget.contains(next))
									)
										closeMenu();
								}}
							>
								<button
									class="icon-action"
									type="button"
									aria-label={`Actions for ${user.username}`}
									aria-haspopup="menu"
									aria-expanded={openMenuId === user.id}
									aria-controls={`user-menu-${user.id}`}
									onclick={(event) => toggleMenu(user, event.currentTarget)}
								>
									<MoreHorizontal size={19} aria-hidden="true" />
								</button>
								{#if openMenuId === user.id}
									<div
										id={`user-menu-${user.id}`}
										class="menu"
										role="menu"
										tabindex="-1"
										aria-label={`Actions for ${user.username}`}
										onkeydown={(event) => onMenuKeydown(event, user)}
									>
										<button
											class="menu-item"
											type="button"
											role="menuitem"
											onclick={() => requestDisable(user)}
										>
											Disable account
										</button>
									</div>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>

			{#if loadMoreError}
				<div class="more-error" role="alert">
					<p>{loadMoreError}</p>
					<button class="text-action" type="button" onclick={loadMore}>
						<RefreshCw size={16} aria-hidden="true" /> Try again
					</button>
				</div>
			{/if}

			{#if hasMore}
				<div class="more">
					<button
						class="load-more"
						type="button"
						onclick={loadMore}
						disabled={loadingMore}
					>
						{#if loadingMore}
							<LoaderCircle class="spin" size={16} aria-hidden="true" />
							<span>Loading…</span>
						{:else}
							<span>Load more</span>
						{/if}
					</button>
				</div>
			{/if}
		{/if}

		{#if notice}
			<p class:error={noticeIsError} class="notice" role={noticeIsError ? 'alert' : 'status'}>
				{notice}
			</p>
		{/if}
	{/if}
</section>

{#if addOpen}
	<div
		class="dialog-backdrop"
		role="presentation"
		onclick={(event) => event.target === event.currentTarget && closeAddDialog()}
	>
		<div
			bind:this={addDialog}
			class="dialog"
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="add-user-title"
			aria-describedby="add-user-description"
			onkeydown={(event) => trapTab(event, addDialog)}
		>
			<h3 id="add-user-title">Add user</h3>
			<p id="add-user-description">
				Creates an ordinary account. The new user must choose a new password at
				first sign-in. Only ordinary accounts can be created.
			</p>
			<form
				class="form"
				onsubmit={(event) => void submitAdd(event)}
				novalidate
			>
				<div class="field">
					<label for="add-username">Username</label>
					<input
						id="add-username"
						name="username"
						type="text"
						autocomplete="off"
						bind:value={addUsername}
						aria-invalid={Boolean(addErrors.username)}
						aria-describedby={addErrors.username ? 'add-username-error' : undefined}
					/>
					{#if addErrors.username}
						<p class="field-error" id="add-username-error">{addErrors.username}</p>
					{/if}
				</div>

				<div class="field">
					<label for="add-initial-password">Initial password</label>
					<input
						id="add-initial-password"
						name="initialPassword"
						type="password"
						autocomplete="new-password"
						bind:value={addInitialPassword}
						aria-invalid={Boolean(addErrors.initialPassword)}
						aria-describedby={addErrors.initialPassword
							? 'add-initial-error'
							: 'add-initial-hint'}
					/>
					{#if addErrors.initialPassword}
						<p class="field-error" id="add-initial-error">{addErrors.initialPassword}</p>
					{:else}
						<p class="hint" id="add-initial-hint">Use 15–128 characters (up to 512 bytes).</p>
					{/if}
				</div>

				<div class="field">
					<label for="add-current-password">Your current password</label>
					<input
						id="add-current-password"
						name="currentPassword"
						type="password"
						autocomplete="current-password"
						bind:value={addCurrentPassword}
						aria-invalid={Boolean(addErrors.currentPassword)}
						aria-describedby={addErrors.currentPassword
							? 'add-current-error'
							: 'add-current-hint'}
					/>
					{#if addErrors.currentPassword}
						<p class="field-error" id="add-current-error">{addErrors.currentPassword}</p>
					{:else}
						<p class="hint" id="add-current-hint">Required to confirm this change.</p>
					{/if}
				</div>

				{#if addFormError}
					<p class="form-error" role="alert">{addFormError}</p>
				{/if}

				<div class="dialog-actions">
					<button
						class="text-action"
						type="button"
						onclick={closeAddDialog}
						disabled={adding}
					>
						Cancel
					</button>
					<button class="text-action primary" type="submit" disabled={adding}>
						{adding ? 'Adding…' : 'Add user'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

{#if disableTarget}
	<div
		class="dialog-backdrop"
		role="presentation"
		onclick={(event) => event.target === event.currentTarget && closeDisableDialog()}
	>
		<div
			bind:this={disableDialog}
			class="dialog"
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="disable-user-title"
			aria-describedby="disable-user-description"
			onkeydown={(event) => trapTab(event, disableDialog)}
		>
			<h3 id="disable-user-title">Disable {disableTarget.username}?</h3>
			<p id="disable-user-description">
				This account will no longer be able to sign in, and all of its active
				sessions will be revoked immediately. The account remains in this list.
			</p>
			<form
				class="form"
				onsubmit={(event) => void submitDisable(event)}
				novalidate
			>
				<div class="field">
					<label for="disable-current-password">Your current password</label>
					<input
						id="disable-current-password"
						name="currentPassword"
						type="password"
						autocomplete="current-password"
						bind:value={disablePassword}
						aria-invalid={Boolean(disableFieldError)}
						aria-describedby={disableFieldError
							? 'disable-current-error'
							: 'disable-current-hint'}
					/>
					{#if disableFieldError}
						<p class="field-error" id="disable-current-error">{disableFieldError}</p>
					{:else}
						<p class="hint" id="disable-current-hint">Required to confirm this change.</p>
					{/if}
				</div>

				{#if disableFormError}
					<p class="form-error" role="alert">{disableFormError}</p>
				{/if}

				<div class="dialog-actions">
					<button
						class="text-action"
						type="button"
						onclick={closeDisableDialog}
						disabled={disabling}
					>
						Cancel
					</button>
					<button class="text-action danger" type="submit" disabled={disabling}>
						{disabling ? 'Disabling…' : 'Disable account'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<style>
	.page { max-width: 680px; }
	.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
	.page-heading h2 { margin: 0; font-size: 24px; letter-spacing: -.04em; }
	.page-heading p:last-child { margin: 8px 0 0; color: var(--color-text-secondary); line-height: 1.6; }
	.eyebrow { margin: 0 0 10px; color: var(--color-text-disabled); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
	.add-user { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; margin-top: 2px; border: 0; background: transparent; padding: 8px 0; color: var(--color-text-primary); font: inherit; cursor: pointer; white-space: nowrap; }
	.add-user:hover { opacity: .72; }
	.add-user:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 4px; border-radius: 4px; }

	.user-list { display: grid; gap: 2px; margin: 36px 0 0; padding: 0; list-style: none; }
	.user-row { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 64px; }
	.glyph { display: grid; place-items: center; width: 36px; height: 36px; color: var(--color-text-secondary); }
	.user-copy { display: grid; gap: 4px; min-width: 0; }
	.user-copy strong { overflow: hidden; font-size: 14px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
	.meta { display: flex; align-items: center; gap: 6px; color: var(--color-text-secondary); font-size: 12px; }
	.meta .disabled { color: var(--color-text-disabled); }

	.row-actions { position: relative; }
	.icon-action { display: grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: 10px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
	.icon-action:hover, .icon-action[aria-expanded='true'] { color: var(--color-text-primary); }
	.icon-action:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
	.menu { position: absolute; z-index: 10; top: calc(100% + 2px); right: 0; min-width: 176px; padding: 6px; border-radius: 12px; background: var(--color-elevated); box-shadow: 0 14px 34px #0009; }
	.menu-item { display: flex; align-items: center; width: 100%; min-height: 44px; border: 0; border-radius: 8px; background: transparent; padding: 8px 10px; color: var(--color-text-primary); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
	.menu-item:hover, .menu-item:focus-visible { background: var(--color-input); }
	.menu-item:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }

	.text-action { display: inline-flex; align-items: center; gap: 7px; min-height: 44px; border: 0; background: transparent; padding: 8px 0; color: var(--color-text-primary); font: inherit; text-decoration: none; cursor: pointer; }
	.text-action:hover { opacity: .72; }
	.text-action:disabled { opacity: .5; cursor: default; }
	.primary { font-weight: 600; }
	.danger { color: var(--color-danger); }
	.load-more { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; border: 0; background: transparent; padding: 8px 0; color: var(--color-text-secondary); font: inherit; cursor: pointer; }
	.load-more:hover { color: var(--color-text-primary); }
	.more { margin-top: 16px; }
	.more-error { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 18px; margin-top: 20px; color: var(--color-danger); }
	.more-error p { margin: 0; font-size: 13px; line-height: 1.5; }
	.notice { margin: 28px 0 0; color: var(--color-text-secondary); font-size: 13px; line-height: 1.5; }
	.notice.error { color: var(--color-danger); }
	.empty { margin-top: 44px; color: var(--color-text-secondary); line-height: 1.6; }
	.state { display: grid; justify-items: start; gap: 8px; margin-top: 40px; color: var(--color-text-secondary); line-height: 1.6; }
	.state p { margin: 0; }
	.state.error { color: var(--color-danger); }

	.restricted { display: grid; justify-items: start; gap: 8px; margin-top: 40px; max-width: 520px; }
	.restricted-icon { display: grid; width: 44px; height: 44px; place-items: center; margin-bottom: 8px; border-radius: 12px; background: var(--color-input); color: var(--color-text-secondary); }
	.restricted h3 { margin: 0; font-size: 17px; line-height: 1.35; }
	.restricted p { margin: 0; color: var(--color-text-secondary); line-height: 1.6; }
	.restricted .text-action { margin-top: 8px; }

	.skeleton .user-row { grid-template-columns: 36px minmax(0, 1fr); }
	.glyph-skeleton { width: 18px; height: 18px; margin-left: 9px; border-radius: 50%; background: var(--color-input); animation: pulse 1.4s ease-in-out infinite; }
	.copy-skeleton { display: grid; gap: 8px; }
	.line { display: block; width: 34%; height: 9px; border-radius: 5px; background: var(--color-input); animation: pulse 1.4s ease-in-out infinite; }
	.line.wide { width: 58%; }
	@keyframes pulse { 50% { opacity: .45; } }

	.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

	.dialog-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 20px; background: #0008; }
	.dialog { width: min(100%, 440px); max-height: calc(100svh - 40px); overflow-y: auto; border-radius: 16px; background: var(--color-elevated); padding: 24px; box-shadow: 0 18px 50px #0008; }
	.dialog h3 { margin: 0; font-size: 18px; letter-spacing: -.02em; }
	.dialog > p { margin: 8px 0 0; color: var(--color-text-secondary); line-height: 1.6; font-size: 13px; }
	.form { display: grid; gap: 16px; margin-top: 22px; }
	.field { display: grid; gap: 7px; }
	label { color: var(--color-text-secondary); font-size: 13px; }
	input { min-height: 44px; border: 0; border-radius: 9px; background: var(--color-input); padding: 10px 12px; color: var(--color-text-primary); }
	input:focus { outline: 2px solid var(--color-focus); outline-offset: 2px; }
	input[aria-invalid='true'] { outline: 1px solid var(--color-danger); outline-offset: 0; }
	.hint { margin: 0; color: var(--color-text-disabled); font-size: 12px; line-height: 1.45; }
	.field-error, .form-error { margin: 0; color: var(--color-danger); font-size: 12px; line-height: 1.45; }
	.dialog-actions { display: flex; justify-content: flex-end; gap: 20px; margin-top: 4px; }
	:global(.spin) { animation: spin 900ms linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	@media (max-width: 599px) {
		.page-head { flex-direction: column; gap: 10px; }
		.add-user { margin-top: 0; }
		.dialog { padding: 20px; }
	}
	@media (prefers-reduced-motion: reduce) {
		.glyph-skeleton, .line { animation: none; }
		:global(.spin) { animation: none; }
	}
</style>
