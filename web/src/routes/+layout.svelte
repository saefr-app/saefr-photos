<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import SessionGate from '#lib/components/SessionGate.svelte';
	import { session } from '#lib/session';

	let { children } = $props();

	onMount(() => {
		void session.bootstrap();
	});
</script>

<SessionGate>{@render children()}</SessionGate>
