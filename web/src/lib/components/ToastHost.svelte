<script lang="ts">
	import { toast } from '#lib/feedback/toast.svelte';
	import SwipeToast from './svelte-bits/SwipeToast.svelte';
</script>

{#if toast.current}
	{@const current = toast.current}
	{#key current.id}
		<SwipeToast
			open={true}
			title={current.title}
			description={current.description ?? ''}
			actionLabel={current.actionLabel ?? ''}
			onAction={current.onAction}
			onClose={() => toast.dismiss(current.id)}
			duration={current.duration ?? 3600}
			fuse="none"
			background="var(--color-elevated)"
			color="var(--color-text-primary)"
			fuseColor="var(--color-text-secondary)"
		/>
	{/key}
{/if}
