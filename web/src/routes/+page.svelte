<svelte:head><title>Saefr</title></svelte:head>

<main class="opening" role="status" aria-live="polite">
	<p>Opening Photos…</p>
</main>

<style>
	.opening {
		display: grid;
		place-items: center;
		min-height: 100svh;
		background: var(--color-canvas);
	}

	p {
		margin: 0;
		color: var(--color-text-secondary);
		font-size: 13px;
	}
</style>
