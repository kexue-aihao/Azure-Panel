<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Account = {
		id: number;
		name: string;
		tenant_id: string;
		client_id: string;
		proxy_enabled: boolean;
		proxy_name: string;
		proxy_label: string;
	};

	type ProxyMode = 'direct' | 'client_ip' | 'profile';
	type ProxySource = 'fixed' | 'client_ip';

	type ProxyProfile = {
		id: number;
		name: string;
		type: 'http' | 'https' | 'socks4' | 'socks4a' | 'socks5' | 'shadowsocks';
		source: ProxySource;
		label: string;
	};

	let accounts = $state<Account[]>([]);
	let proxies = $state<ProxyProfile[]>([]);
	let form = $state({
		tenant_id: '',
		client_id: '',
		client_secret: '',
		proxy_mode: 'direct' as ProxyMode,
		proxy_profile_id: ''
	});
	let toast = $state('');
	let fixedProxies = $derived(proxies.filter((proxy) => proxy.source === 'fixed'));
	let clientIpProxies = $derived(proxies.filter((proxy) => proxy.source === 'client_ip'));

	function resetForm() {
		form = {
			tenant_id: '',
			client_id: '',
			client_secret: '',
			proxy_mode: 'direct',
			proxy_profile_id: ''
		};
	}

	function syncProxySelection() {
		if (form.proxy_mode === 'direct') {
			form.proxy_profile_id = '';
			return;
		}

		const options = form.proxy_mode === 'client_ip' ? clientIpProxies : fixedProxies;
		if (!options.some((proxy) => String(proxy.id) === form.proxy_profile_id)) {
			form.proxy_profile_id = options[0] ? String(options[0].id) : '';
		}
	}

	async function load() {
		const [accountList, proxyList] = await Promise.all([
			api<Account[]>('/api/user/azure/account/list'),
			api<ProxyProfile[]>('/api/user/proxy/list')
		]);
		accounts = accountList;
		proxies = proxyList;
		syncProxySelection();
	}

	async function submit(e: Event) {
		e.preventDefault();
		syncProxySelection();
		if (form.proxy_mode !== 'direct' && !form.proxy_profile_id) {
			toast =
				form.proxy_mode === 'client_ip'
					? '请先在“代理配置”添加一个使用当前访问网站 IP 的代理档案'
					: '请先选择一个自定义代理档案';
			return;
		}

		const payload = {
			tenant_id: form.tenant_id,
			client_id: form.client_id,
			client_secret: form.client_secret,
			proxy_profile_id: form.proxy_mode === 'direct' ? '' : form.proxy_profile_id
		};

		try {
			await api('/api/user/azure/account/add', {
				method: 'POST',
				body: JSON.stringify(payload)
			});
			toast = '账号添加成功';
			resetForm();
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : '添加失败';
		}
	}

	async function remove(id: number) {
		if (!confirm('确认删除这个账号吗？')) return;
		try {
			await api(`/api/user/azure/account/delete?account_id=${id}`, { method: 'DELETE' });
			toast = '已删除';
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : '删除失败';
		}
	}

	onMount(() => {
		void load();
	});
</script>

<h1 class="mb-4 text-2xl font-semibold">Azure 账号</h1>

{#if toast}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm">{toast}</div>
{/if}

<div class="grid gap-6 lg:grid-cols-2">
	<form class="card space-y-3 p-5" onsubmit={submit}>
		<h2 class="text-lg font-medium">添加 Service Principal</h2>
		<p class="text-sm text-muted">
			默认由部署本网站的服务器直接请求 Azure API，Azure 侧看到的是服务器源站出站 IP。
			选择代理配置后，此账号的验证、VM 查询、开关机和自动补机会走代理出口 IP。
		</p>
		<input class="input" bind:value={form.tenant_id} placeholder="Tenant ID" required />
		<input class="input" bind:value={form.client_id} placeholder="Client ID" required />
		<input
			class="input"
			bind:value={form.client_secret}
			type="password"
			placeholder="Client Secret"
			required
		/>

		<div class="space-y-2">
			<label class="text-sm text-muted" for="account-proxy-mode">账号出站方式</label>
			<select
				id="account-proxy-mode"
				class="input"
				bind:value={form.proxy_mode}
				onchange={syncProxySelection}
			>
				<option value="direct">不使用代理（服务器源站 IP）</option>
				<option value="client_ip">使用当前访问网站 IP 的代理档案</option>
				<option value="profile">选择自定义代理档案</option>
			</select>
		</div>

		{#if form.proxy_mode === 'client_ip'}
			{#if clientIpProxies.length === 0}
				<div class="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted">
					还没有“当前访问网站 IP”代理档案，请先到“代理配置”添加。该访问者 IP
					必须运行对应的 HTTP/SOCKS/Shadowsocks 代理端口。
				</div>
			{:else}
				<select class="input" bind:value={form.proxy_profile_id} required>
					{#each clientIpProxies as proxy}
						<option value={String(proxy.id)}>{proxy.name} - {proxy.label}</option>
					{/each}
				</select>
			{/if}
		{:else if form.proxy_mode === 'profile'}
			{#if fixedProxies.length === 0}
				<div class="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted">
					还没有自定义固定代理档案，请先到“代理配置”添加 HTTP/SOCKS/Shadowsocks/本机代理。
				</div>
			{:else}
				<select class="input" bind:value={form.proxy_profile_id} required>
					{#each fixedProxies as proxy}
						<option value={String(proxy.id)}>{proxy.name} - {proxy.label}</option>
					{/each}
				</select>
			{/if}
		{/if}
		<p class="text-xs text-muted">
			这里只需要填写 Azure 登录凭据三项。选择代理档案后，此账号的验证、VM 查询、开关机和自动补机会走该代理出口。
		</p>
		<button class="btn-primary" type="submit">保存账号</button>
	</form>

	<div class="card space-y-3 p-5">
		<h2 class="text-lg font-medium">已添加账号</h2>
		{#if accounts.length === 0}
			<p class="text-sm text-muted">还没有账号</p>
		{:else}
			{#each accounts as account}
				<div class="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
					<div>
						<div class="font-medium">{account.name}</div>
						<div class="mt-1 text-xs text-muted">租户: {account.tenant_id}</div>
						<div class="text-xs text-muted">Client ID: {account.client_id}</div>
						<div class="text-xs text-muted">
							出站: {account.proxy_enabled
								? `代理 ${account.proxy_name ? `${account.proxy_name} ` : ''}${account.proxy_label}`
								: '服务器源站 IP'}
						</div>
					</div>
					<button class="btn-danger" onclick={() => void remove(account.id)}>删除</button>
				</div>
			{/each}
		{/if}
	</div>
</div>
