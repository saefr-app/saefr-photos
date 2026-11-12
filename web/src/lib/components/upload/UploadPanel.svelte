<script lang="ts">
	import {
		ChevronDown,
		ChevronUp,
		Minus,
		RefreshCw,
		Upload,
		X
	} from '@lucide/svelte';
	import { upload } from '#lib/upload/upload.svelte';
	import type { UploadItem } from '#lib/upload/queue';

	let expanded = $state(false);
	let minimized = $state(false);

	const total = $derived(upload.total);
	const completed = $derived(upload.completed);
	const failed = $derived(upload.failed);
	const active = $derived(upload.active);
	const percent = $derived(
		total === 0 ? 0 : Math.round((completed / total) * 100)
	);
	const allSuccess = $derived(total > 0 && completed === total);

	const summary = $derived(
		active
			? `Uploading · ${completed} of ${total} completed`
			: allSuccess
				? `Upload complete · ${completed} of ${total}`
				: `Uploads · ${completed} of ${total} completed`
	);

	const miniSummary = $derived(
		failed > 0 && !active
			? `Uploads · ${failed} ${failed === 1 ? 'file needs' : 'files need'} attention`
			: summary
	);

	const blockedMessage = $derived.by(() => {
		switch (upload.blocked) {
			case 'uncertain':
				return 'An upload outcome is unclear. Check the gallery before retrying.';
			case 'unauthorized':
				return 'Your session ended. Sign in again to continue.';
			case 'forbidden':
				return 'This account cannot upload photos right now.';
			case 'rate-limited':
				return 'Uploads are paused after too many attempts. Retry when ready.';
			case 'unavailable':
				return 'Saefr is temporarily unavailable. Retry when ready.';
			default:
				return '';
		}
	});

	function itemLabel(item: UploadItem): string {
		switch (item.status) {
			case 'pending':
				return 'Waiting';
			case 'uploading':
				return 'Uploading…';
			case 'success':
				return 'Uploaded';
			case 'uncertain':
				return 'Check gallery before retry.';
			case 'error':
				return item.error?.message ?? 'Upload failed.';
		}
	}
</script>

{#if total > 0}
	{#if minimized}
		<button
			type="button"
			class="mini"
			aria-label={`${miniSummary}. Show uploads.`}
			onclick={() => (minimized = false)}
		>
			<span class="mini-label">{miniSummary}</span>
			<span class="mini-progress" aria-hidden="true">
				<span style:width={`${percent}%`}></span>
			</span>
		</button>
	{:else}
		<section class="panel" aria-label="Uploads">
			<div class="head">
				<div class="head-copy">
					<strong class="summary" aria-live="polite">{summary}</strong>
					{#if failed > 0 && !active}
						<span class="sub"
							>{failed} {failed === 1 ? 'file needs' : 'files need'} attention</span
						>
					{:else if active}
						<span class="sub">{percent}%</span>
					{/if}
				</div>
				<div class="head-actions">
					<button
						type="button"
						class="icon"
						aria-label={expanded ? 'Hide file list' : 'Show file list'}
						aria-expanded={expanded}
						onclick={() => (expanded = !expanded)}
					>
						{#if expanded}<ChevronUp size={17} />{:else}<ChevronDown size={17} />{/if}
					</button>
					<button
						type="button"
						class="icon"
						aria-label="Minimize uploads"
						onclick={() => (minimized = true)}
					>
						<Minus size={17} />
					</button>
					{#if upload.canClose}
						<button
							type="button"
							class="icon"
							aria-label="Close uploads"
							onclick={() => upload.dismissAll()}
						>
							<X size={17} />
						</button>
					{/if}
				</div>
			</div>

			<div
				class="progress"
				role="progressbar"
				aria-label="Upload progress"
				aria-valuemin={0}
				aria-valuemax={total}
				aria-valuenow={completed}
			>
				<span style:width={`${percent}%`}></span>
			</div>

			{#if blockedMessage}
				<p class="halt" role="alert">{blockedMessage}</p>
			{/if}

			{#if upload.duplicateCount > 0}
				<p class="note">
					Skipped {upload.duplicateCount}
					{upload.duplicateCount === 1 ? 'duplicate file' : 'duplicate files'}.
					<button
						type="button"
						class="inline"
						onclick={() => upload.clearDuplicateNotice()}
					>
						Dismiss
					</button>
				</p>
			{/if}

			{#if expanded}
				<ul class="files">
					{#each upload.items as item (item.id)}
						<li class="file">
							<span class="file-copy">
								<span class="name" title={item.name}>{item.name}</span>
								<span
									class="status"
									class:error={item.status === 'error'}
									class:warning={item.status === 'uncertain'}
									class:done={item.status === 'success'}
								>
									{itemLabel(item)}
								</span>
							</span>
							<span class="file-actions">
								{#if item.status === 'error' || item.status === 'uncertain'}
									<button
										type="button"
										class="inline"
										aria-label={`Retry ${item.name}`}
										onclick={() => upload.retry(item.id)}
									>
										<RefreshCw size={14} aria-hidden="true" />
										Retry
									</button>
								{/if}
								{#if item.status === 'success' || item.status === 'error' || item.status === 'uncertain'}
									<button
										type="button"
										class="icon small"
										aria-label={`Dismiss ${item.name}`}
										onclick={() => upload.dismiss(item.id)}
									>
										<X size={15} />
									</button>
								{/if}
							</span>
						</li>
					{/each}
				</ul>
				<p class="hint">
					<Upload size={14} aria-hidden="true" />
					Uploads continue while this tab stays open.
				</p>
			{/if}
		</section>
	{/if}
{/if}

<style>
	.panel {
		position: fixed;
		z-index: 35;
		right: 24px;
		bottom: 24px;
		width: min(360px, calc(100vw - 32px));
		padding: 12px 16px 16px;
		border-radius: 14px;
		background: var(--color-elevated);
		box-shadow: 0 12px 30px #0008;
		animation: panel-in var(--duration-panel) var(--ease-out) both;
	}

	.mini {
		position: fixed;
		z-index: 35;
		right: 24px;
		bottom: 24px;
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 44px;
		max-width: min(360px, calc(100vw - 32px));
		padding: 0 14px;
		border: 0;
		border-radius: 12px;
		color: var(--color-text-primary);
		background: var(--color-elevated);
		box-shadow: 0 12px 30px #0008;
		cursor: pointer;
	}

	.mini-label {
		overflow: hidden;
		font-size: 13px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.mini-progress {
		flex: 0 0 64px;
		height: 3px;
		overflow: hidden;
		border-radius: 999px;
		background: var(--color-input);
	}

	.mini-progress span {
		display: block;
		height: 100%;
		background: var(--color-text-secondary);
	}

	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
	}

	.head-copy {
		display: grid;
		gap: 2px;
		min-width: 0;
		padding-top: 3px;
	}

	.summary {
		font-size: 13px;
		font-weight: 600;
		line-height: 1.3;
	}

	.sub {
		color: var(--color-text-secondary);
		font-size: 12px;
	}

	.head-actions {
		display: flex;
		flex: 0 0 auto;
		margin: -6px -10px 0 0;
	}

	.icon {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		padding: 0;
		border: 0;
		border-radius: 8px;
		color: var(--color-text-secondary);
		background: none;
		cursor: pointer;
	}

	.icon:hover,
	.inline:hover {
		color: var(--color-text-primary);
	}

	.icon.small {
		width: 36px;
		height: 36px;
	}

	.progress {
		height: 3px;
		margin-top: 10px;
		overflow: hidden;
		border-radius: 999px;
		background: var(--color-input);
	}

	.progress > span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--color-text-secondary);
		transition: width var(--duration-ui) var(--ease-out);
	}

	.halt {
		margin: 10px 0 0;
		color: var(--color-danger);
		font-size: 12px;
		line-height: 1.45;
	}

	.note {
		margin: 10px 0 0;
		color: var(--color-text-secondary);
		font-size: 12px;
		line-height: 1.45;
	}

	.inline {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: 32px;
		padding: 0 4px;
		border: 0;
		color: var(--color-text-primary);
		background: none;
		font-size: 12px;
		cursor: pointer;
	}

	.files {
		max-height: 220px;
		margin: 10px 0 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
	}

	.file {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
	}

	.file-copy {
		display: grid;
		flex: 1;
		gap: 1px;
		min-width: 0;
	}

	.name {
		overflow: hidden;
		font-size: 12.5px;
		line-height: 1.35;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.status {
		color: var(--color-text-secondary);
		font-size: 11.5px;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.status.done {
		color: var(--color-text-primary);
	}

	.status.warning {
		color: var(--color-text-primary);
	}

	.status.error {
		color: var(--color-danger);
	}

	.file-actions {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 2px;
	}

	.hint {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 10px 0 0;
		color: var(--color-text-secondary);
		font-size: 11px;
		line-height: 1.4;
	}

	.hint :global(svg) {
		flex: 0 0 auto;
	}

	@keyframes panel-in {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.98);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	@media (max-width: 599px) {
		.panel,
		.mini {
			right: 10px;
			bottom: calc(78px + env(safe-area-inset-bottom));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.panel {
			animation: none;
		}

		.progress > span {
			transition: none;
		}
	}
</style>
