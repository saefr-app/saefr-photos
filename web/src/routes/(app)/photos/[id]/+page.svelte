<script lang="ts">
	import { page } from '$app/state';
	import PhotoViewer from '#lib/components/viewer/PhotoViewer.svelte';
</script>

{#key page.params.id}
	<PhotoViewer id={page.params.id ?? ''} />
{/key}
