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
		proxy_profile_id: number | null;
		proxy_source: ProxySource | '';
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

	type ClientIpProxyStatus = {
		client_ip: string;
		available: boolean;
		message: string;
		profile: ProxyProfile | null;
		candidates: {
			type: string;
			port: number;
			label: string;
			available: boolean;
			error: string;
		}[];
	};

	let accounts = $state<Account[]>([]);
	let proxies = $state<ProxyProfile[]>([]);
	let clientIpProxy = $state<ClientIpProxyStatus | null>(null);
	let form = $state({
		tenant_id: '',
		client_id: '',
		client_secret: '',
		proxy_mode: 'direct' as ProxyMode,
		proxy_profile_id: ''
	});
	let toast = $state('');
	let accountProxyDrafts = $state<Record<number, { proxy_mode: ProxyMode; proxy_profile_id: string }>>({});
	let proxySavingAccountId = $state<number | null>(null);
	let fixedProxies = $derived(proxies.filter((proxy) => proxy.source === 'fixed'));

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

		if (form.proxy_mode === 'client_ip') {
			form.proxy_profile_id = '';
			return;
		}

		const options = fixedProxies;
		if (!options.some((proxy) => String(proxy.id) === form.proxy_profile_id)) {
			form.proxy_profile_id = options[0] ? String(options[0].id) : '';
		}
	}

	function accountProxyMode(account: Account): ProxyMode {
		if (account.proxy_source === 'client_ip') return 'client_ip';
		return account.proxy_profile_id ? 'profile' : 'direct';
	}

	function defaultAccountProxyDraft(account: Account) {
		return {
			proxy_mode: accountProxyMode(account),
			proxy_profile_id: account.proxy_profile_id ? String(account.proxy_profile_id) : ''
		};
	}

	function syncAccountProxyDrafts(accountList = accounts) {
		const next: Record<number, { proxy_mode: ProxyMode; proxy_profile_id: string }> = {};
		for (const account of accountList) {
			next[account.id] = defaultAccountProxyDraft(account);
			if (next[account.id].proxy_mode === 'profile' && !next[account.id].proxy_profile_id) {
				next[account.id].proxy_profile_id = fixedProxies[0] ? String(fixedProxies[0].id) : '';
			}
			if (next[account.id].proxy_mode !== 'profile') {
				next[account.id].proxy_profile_id = '';
			}
		}
		accountProxyDrafts = next;
	}

	function setAccountProxyMode(account: Account, mode: ProxyMode) {
		accountProxyDrafts = {
			...accountProxyDrafts,
			[account.id]: {
				proxy_mode: mode,
				proxy_profile_id:
					mode === 'profile'
						? accountProxyDrafts[account.id]?.proxy_profile_id || (fixedProxies[0] ? String(fixedProxies[0].id) : '')
						: ''
			}
		};
	}

	function setAccountProxyProfile(account: Account, proxyProfileId: string) {
		accountProxyDrafts = {
			...accountProxyDrafts,
			[account.id]: {
				proxy_mode: 'profile',
				proxy_profile_id: proxyProfileId
			}
		};
	}

	async function load() {
		const [accountList, proxyList] = await Promise.all([
			api<Account[]>('/api/user/azure/account/list'),
			api<ProxyProfile[]>('/api/user/proxy/list')
		]);
		accounts = accountList;
		proxies = proxyList;
		syncProxySelection();
		syncAccountProxyDrafts(accountList);
	}

	async function loadClientIpProxy() {
		try {
			clientIpProxy = await api<ClientIpProxyStatus>('/api/user/proxy/client-ip');
		} catch (err) {
			clientIpProxy = {
				client_ip: '',
				available: false,
				profile: null,
				candidates: [],
				message: err instanceof Error ? err.message : '当前访问 IP 识别失败'
			};
		}
	}

	async function submit(e: Event) {
		e.preventDefault();
		syncProxySelection();
		if (form.proxy_mode === 'profile' && !form.proxy_profile_id) {
			toast = '请先选择一个自定义代理档案';
			return;
		}

		const payload = {
			tenant_id: form.tenant_id,
			client_id: form.client_id,
			client_secret: form.client_secret,
			proxy_mode: form.proxy_mode,
			proxy_profile_id: form.proxy_mode === 'profile' ? form.proxy_profile_id : ''
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

	async function saveAccountProxy(account: Account) {
		const draft = accountProxyDrafts[account.id] ?? defaultAccountProxyDraft(account);
		if (draft.proxy_mode === 'profile' && !draft.proxy_profile_id) {
			toast = '请先选择一个自定义代理档案';
			return;
		}

		proxySavingAccountId = account.id;
		try {
			await api('/api/user/azure/account/proxy', {
				method: 'POST',
				body: JSON.stringify({
					account_id: account.id,
					proxy_mode: draft.proxy_mode,
					proxy_profile_id: draft.proxy_mode === 'profile' ? draft.proxy_profile_id : ''
				})
			});
			toast = `已更新 ${account.name} 的代理出口`;
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : '代理切换失败';
		} finally {
			proxySavingAccountId = null;
		}
	}

	onMount(() => {
		void load();
		void loadClientIpProxy();
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
				<option value="client_ip">使用当前访问网站 IP（自动识别）</option>
				<option value="profile">选择自定义代理档案</option>
			</select>
		</div>

		{#if form.proxy_mode === 'client_ip'}
			{#if clientIpProxy}
				<div
					class="rounded-lg border border-border bg-background px-3 py-2 text-sm {clientIpProxy.available
						? 'text-emerald-300'
						: 'text-muted'}"
				>
					<div>识别 IP: {clientIpProxy.client_ip || '-'}</div>
					<div>{clientIpProxy.message}</div>
				</div>
			{:else}
				<div class="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted">
					正在识别当前访问网站 IP...
				</div>
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
				<div class="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-[1fr_auto]">
					<div class="min-w-0">
						<div class="font-medium">{account.name}</div>
						<div class="mt-1 text-xs text-muted">租户: {account.tenant_id}</div>
						<div class="text-xs text-muted">Client ID: {account.client_id}</div>
						<div class="text-xs text-muted">
							出站: {account.proxy_enabled
								? `代理 ${account.proxy_name ? `${account.proxy_name} ` : ''}${account.proxy_label}`
								: '服务器源站 IP'}
						</div>
						<div class="mt-3 grid gap-2 lg:grid-cols-[180px_1fr_auto]">
							<select
								class="input"
								value={accountProxyDrafts[account.id]?.proxy_mode ?? accountProxyMode(account)}
								onchange={(event) =>
									setAccountProxyMode(account, (event.currentTarget as HTMLSelectElement).value as ProxyMode)}
							>
								<option value="direct">服务器源站 IP</option>
								<option value="client_ip">当前访问网站 IP</option>
								<option value="profile">自定义代理</option>
							</select>

							{#if (accountProxyDrafts[account.id]?.proxy_mode ?? accountProxyMode(account)) === 'profile'}
								{#if fixedProxies.length === 0}
									<div class="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted">
										暂无自定义代理，请先到“代理配置”添加。
									</div>
								{:else}
									<select
										class="input"
										value={accountProxyDrafts[account.id]?.proxy_profile_id ?? ''}
										onchange={(event) =>
											setAccountProxyProfile(account, (event.currentTarget as HTMLSelectElement).value)}
									>
										{#each fixedProxies as proxy}
											<option value={String(proxy.id)}>{proxy.name} - {proxy.label}</option>
										{/each}
									</select>
								{/if}
							{:else if (accountProxyDrafts[account.id]?.proxy_mode ?? accountProxyMode(account)) === 'client_ip'}
								<div class="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted">
									{clientIpProxy?.message ?? '保存时会自动识别当前访问网站 IP 的可用代理端口'}
								</div>
							{:else}
								<div class="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted">
									Azure 请求将直接从服务器源站 IP 出口访问。
								</div>
							{/if}

							<button
								class="btn-secondary"
								type="button"
								onclick={() => void saveAccountProxy(account)}
								disabled={proxySavingAccountId === account.id}
							>
								{proxySavingAccountId === account.id ? '保存中...' : '保存代理'}
							</button>
						</div>
						{#if proxySavingAccountId === account.id}
							<div class="progress-track running mt-3">
								<div class="progress-fill bg-primary" style="width: 70%"></div>
							</div>
							<div class="mt-1 text-xs text-muted">正在保存此账号的代理出口配置...</div>
						{/if}
					</div>
					<div class="flex shrink-0 flex-col gap-2">
						<a class="btn-secondary" href={`/resources?account_id=${account.id}`}>查看资源</a>
						<button class="btn-danger" onclick={() => void remove(account.id)}>删除</button>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>
