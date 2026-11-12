<script lang="ts">
	import { Loader } from '@lucide/svelte';
	import { onMount } from 'svelte';

	let {
		filename,
		busy = false,
		error = '',
		onCancel,
		onConfirm
	}: {
		filename: string;
		busy?: boolean;
		error?: string;
		onCancel: () => void;
		onConfirm: () => void;
	} = $props();

	let dialog = $state<HTMLDivElement | null>(null);
	let cancelButton = $state<HTMLButtonElement | null>(null);
	let previouslyFocused: HTMLElement | null = null;

	function focusables(): HTMLElement[] {
		if (!dialog) return [];
		return Array.from(
			dialog.querySelectorAll<HTMLElement>(
				'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
			)
		).filter((element) => element.getClientRects().length > 0);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			if (!busy) onCancel();
			return;
		}
		if (event.key !== 'Tab') return;

		const nodes = focusables();
		if (nodes.length === 0) {
			event.preventDefault();
			return;
		}
		const first = nodes[0];
		const last = nodes[nodes.length - 1];
		const active = document.activeElement;
		if (event.shiftKey && (active === first || !dialog?.contains(active))) {
			event.preventDefault();
			last.focus();
			return;
		}
		if (!event.shiftKey && active === last) {
			event.preventDefault();
			first.focus();
		}
	}

	function onBackdropClick(event: MouseEvent) {
		if (event.target !== event.currentTarget || busy) return;
		onCancel();
	}

	onMount(() => {
		previouslyFocused =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		cancelButton?.focus({ preventScroll: true });
		return () => {
			// The trigger may have been removed after a successful deletion.
			if (previouslyFocused?.isConnected)
				previouslyFocused.focus({ preventScroll: true });
		};
	});
</script>

<div class="backdrop" role="presentation" onclick={onBackdropClick}>
	<div
		bind:this={dialog}
		class="dialog"
		role="alertdialog"
		tabindex="-1"
		aria-modal="true"
		aria-labelledby="delete-permanent-title"
		aria-describedby="delete-permanent-description"
		aria-busy={busy}
		onkeydown={onKeydown}
	>
		<h2 id="delete-permanent-title">Delete permanently?</h2>
		<p id="delete-permanent-description">
			This removes <strong>{filename}</strong> from Trash and cannot be undone.
			If storage cannot finish now, the deletion stays visible in Pending
			deletions and Saefr will not retry it automatically.
		</p>

		{#if error}
			<p class="error" role="alert">{error}</p>
		{/if}

		<div class="dialog-actions">
			<button
				bind:this={cancelButton}
				type="button"
				class="text-action"
				disabled={busy}
				onclick={onCancel}
			>
				Cancel
			</button>
			<button
				type="button"
				class="text-action delete"
				disabled={busy}
				aria-busy={busy}
				onclick={onConfirm}
			>
				{#if busy}
					<span class="spin" aria-hidden="true"><Loader size={16} /></span>
					<span>Deleting…</span>
				{:else}
					<span>Delete permanently</span>
				{/if}
			</button>
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		z-index: 45;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 20px;
		background: #0009;
	}

	.dialog {
		width: min(420px, 100%);
		padding: 24px;
		border-radius: 16px;
		background: var(--color-elevated);
		box-shadow: 0 18px 50px #000b;
		color: var(--color-text-primary);
	}

	h2 {
		margin: 0;
		font-size: 18px;
		letter-spacing: -0.01em;
	}

	p {
		margin: 10px 0 0;
		color: var(--color-text-secondary);
		font-size: 13px;
		line-height: 1.5;
	}

	p strong {
		color: var(--color-text-primary);
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	.error {
		color: var(--color-danger);
	}

	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		margin-top: 24px;
	}

	.text-action {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		padding: 0 8px;
		border: 0;
		color: var(--color-text-primary);
		background: none;
		cursor: pointer;
	}

	.text-action:hover:not(:disabled) {
		opacity: 0.8;
	}

	.text-action:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.delete {
		color: var(--color-danger);
	}

	.spin {
		display: grid;
		place-items: center;
		animation: spin 900ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spin {
			animation: none;
		}
	}
</style>
