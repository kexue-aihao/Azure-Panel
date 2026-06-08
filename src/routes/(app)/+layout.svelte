<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { api } from '$lib/api';
	import { createTranslator, languages, normalizeLanguage, type LanguageCode } from '$lib/i18n';
	import { onMount } from 'svelte';

	let { children } = $props();
	let email = $state('');
	let isAdmin = $state(false);
	let language = $state<LanguageCode>('zh');
	let t = $derived(createTranslator(language));

	type CurrentUser = {
		id: number;
		email: string;
		role: string;
		is_admin: boolean;
		disabled: boolean;
	};

	const baseNav = [
		{ href: '/vms', labelKey: 'nav.vms' },
		{ href: '/accounts', labelKey: 'nav.accounts' },
		{ href: '/resources', labelKey: 'nav.resources' },
		{ href: '/proxies', labelKey: 'nav.proxies' },
		{ href: '/dns', labelKey: 'nav.dns' },
		{ href: '/workflows', labelKey: 'nav.workflows' },
		{ href: '/notifications', labelKey: 'nav.notifications' },
		{ href: '/logs', labelKey: 'nav.logs' },
		{ href: '/security', labelKey: 'nav.security' }
	];
	const nav = $derived(
		isAdmin ? [...baseNav, { href: '/admin', labelKey: 'nav.admin' }] : baseNav
	);

	function setLanguage(value: string) {
		language = normalizeLanguage(value);
		localStorage.setItem('language', language);
		window.dispatchEvent(new CustomEvent('azure-panel-language-change', { detail: language }));
	}

	async function loadCurrentUser() {
		try {
			const user = await api<CurrentUser>('/api/user/me');
			email = user.email;
			isAdmin = user.is_admin;
			localStorage.setItem('email', user.email);
			localStorage.setItem('role', user.role);
			localStorage.setItem('is_admin', String(user.is_admin));
			localStorage.setItem('user', JSON.stringify(user));
		} catch {
			logout();
		}
	}

	onMount(() => {
		if (!localStorage.getItem('token')) {
			goto('/login');
			return;
		}
		email = localStorage.getItem('email') ?? '';
		isAdmin = localStorage.getItem('is_admin') === 'true';
		language = normalizeLanguage(localStorage.getItem('language'));
		void loadCurrentUser();
	});

	function logout() {
		localStorage.removeItem('token');
		localStorage.removeItem('email');
		localStorage.removeItem('role');
		localStorage.removeItem('is_admin');
		localStorage.removeItem('user');
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
					{t(item.labelKey)}
				</a>
			{/each}
		</nav>
		<label class="mt-8 block text-xs text-muted" for="panel-language">{t('language.label')}</label>
		<select
			id="panel-language"
			class="input mt-1"
			value={language}
			onchange={(event) => setLanguage(event.currentTarget.value)}
		>
			{#each languages as option}
				<option value={option.code}>{option.label}</option>
			{/each}
		</select>
		<button class="btn-secondary mt-3 w-full" onclick={logout}>{t('nav.logout')}</button>
	</aside>

	<main class="flex-1 p-4 md:p-6">
		<div class="mb-4 flex gap-2 md:hidden">
			{#each nav as item}
				<a class="btn-secondary text-xs" href={item.href}>{t(item.labelKey)}</a>
			{/each}
		</div>
		{@render children()}
	</main>
</div>
