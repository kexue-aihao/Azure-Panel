<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';

	let { children } = $props();
	let email = $state('');

	const nav = [
		{ href: '/vms', label: 'VM 管理' },
		{ href: '/accounts', label: 'Azure 账号' },
		{ href: '/resources', label: '资源浏览' },
		{ href: '/proxies', label: '代理配置' },
		{ href: '/dns', label: 'DNS 管理' },
		{ href: '/workflows', label: '自动补机' },
		{ href: '/logs', label: '执行日志' }
	];

	onMount(() => {
		if (!localStorage.getItem('token')) {
			goto('/login');
			return;
		}
		email = localStorage.getItem('email') ?? '';
	});

	function logout() {
		localStorage.removeItem('token');
		localStorage.removeItem('email');
		goto('/login');
	}
</script>

<div class="flex min-h-screen">
	<aside class="hidden w-64 shrink-0 border-r border-border p-4 md:block">
		<div class="mb-8 flex items-center gap-3">
			<div class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/20 font-bold text-primary">A</div>
			<div>
				<div class="font-semibold">Azure Panel</div>
				<div class="text-xs text-muted">{email}</div>
			</div>
		</div>
		<nav class="space-y-1">
			{#each nav as item}
				<a class="nav-item {$page.url.pathname === item.href ? 'active' : ''}" href={item.href}>
					{item.label}
				</a>
			{/each}
		</nav>
		<button class="btn-secondary mt-8 w-full" onclick={logout}>退出登录</button>
	</aside>

	<main class="flex-1 p-4 md:p-6">
		<div class="mb-4 flex gap-2 md:hidden">
			{#each nav as item}
				<a class="btn-secondary text-xs" href={item.href}>{item.label}</a>
			{/each}
		</div>
		{@render children()}
	</main>
</div>
