<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';

	onMount(() => {
		const token = localStorage.getItem('token');
		goto(token ? '/vms' : '/login', { replaceState: true });
	});
</script>

<div class="flex min-h-screen items-center justify-center text-muted">正在跳转...</div>
