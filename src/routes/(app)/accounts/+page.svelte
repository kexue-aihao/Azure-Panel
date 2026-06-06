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

	type QuickAzureCredential = {
		email: string;
		password: string;
		regions: string[];
		clientId: string;
		clientName: string;
		clientSecret: string;
		tenantId: string;
	};
	type AccountAddResult = Account & { pool_count?: number };
	type AccountPoolCheckResult = {
		pool_count: number;
		notified: boolean;
		sent: number;
		failed: number;
		notify_error: string;
	};
	type AccountNormalNotifyResult = {
		total_count: number;
		normal_count: number;
		abnormal_count: number;
		check_failed: number;
		notified: boolean;
		sent: number;
		notify_failed: number;
		notify_error: string;
	};

	let accounts = $state<Account[]>([]);
	let proxies = $state<ProxyProfile[]>([]);
	let clientIpProxy = $state<ClientIpProxyStatus | null>(null);
	let form = $state({
		name: '',
		tenant_id: '',
		client_id: '',
		client_secret: '',
		proxy_mode: 'direct' as ProxyMode,
		proxy_profile_id: ''
	});
	let quickInput = $state('');
	let quickParsed = $state<QuickAzureCredential | null>(null);
	let toast = $state('');
	let accountProxyDrafts = $state<Record<number, { proxy_mode: ProxyMode; proxy_profile_id: string }>>({});
	let proxySavingAccountId = $state<number | null>(null);
	let checkingPoolCount = $state(false);
	let checkingNormalSubscriptions = $state(false);
	let fixedProxies = $derived(proxies.filter((proxy) => proxy.source === 'fixed'));

	function resetForm() {
		form = {
			name: '',
			tenant_id: '',
			client_id: '',
			client_secret: '',
			proxy_mode: 'direct',
			proxy_profile_id: ''
		};
	}

	function parseQuickAzureCredential(value: string): QuickAzureCredential {
		const raw = value.trim();
		if (!raw) throw new Error('请先粘贴 API 信息资料');

		const [accountPart, credentialPartRaw] = raw.split('-----');
		const credentialPart = (credentialPartRaw ?? accountPart).trim();
		const accountFields = credentialPartRaw
			? accountPart.split('|').map((item) => item.trim())
			: [];
		const credentialFields = credentialPart.split(':').map((item) => item.trim());
		if (credentialFields.length < 4) {
			throw new Error('格式识别失败：需要包含 clientId:name:clientSecret:tenantId');
		}

		const tenantId = credentialFields.at(-1) ?? '';
		const clientSecret = credentialFields.at(-2) ?? '';
		const clientId = credentialFields[0] ?? '';
		const clientName = credentialFields.slice(1, -2).join(':');
		if (!tenantId || !clientId || !clientSecret) {
			throw new Error('识别失败：Tenant ID、Client ID 或 Client Secret 为空');
		}

		return {
			email: accountFields[0] ?? '',
			password: accountFields[1] ?? '',
			regions: (accountFields[2] ?? '')
				.split(',')
				.map((item) => item.trim())
				.filter(Boolean),
			clientId,
			clientName,
			clientSecret,
			tenantId
		};
	}

	function fillQuickToForm(parsed: QuickAzureCredential) {
		form = {
			...form,
			name: parsed.email || parsed.clientName || '',
			tenant_id: parsed.tenantId,
			client_id: parsed.clientId,
			client_secret: parsed.clientSecret
		};
	}

	function identifyQuickInput() {
		try {
			quickParsed = parseQuickAzureCredential(quickInput);
			fillQuickToForm(quickParsed);
			toast = '已识别 API 信息，并填充到上方三项 Azure 凭据';
		} catch (err) {
			quickParsed = null;
			toast = err instanceof Error ? err.message : '快速识别失败';
		}
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

	async function saveCurrentAccount() {
		syncProxySelection();
		if (form.proxy_mode === 'profile' && !form.proxy_profile_id) {
			toast = '请先选择一个自定义代理档案';
			return;
		}

		const payload = {
			name: form.name,
			tenant_id: form.tenant_id,
			client_id: form.client_id,
			client_secret: form.client_secret,
			proxy_mode: form.proxy_mode,
			proxy_profile_id: form.proxy_mode === 'profile' ? form.proxy_profile_id : ''
		};

		try {
			const result = await api<AccountAddResult>('/api/user/azure/account/add', {
				method: 'POST',
				body: JSON.stringify(payload)
			});
			toast = `账号已加入 Azure 号池，当前剩余 ${result.pool_count ?? accounts.length + 1} 个账号`;
			resetForm();
			quickParsed = null;
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : '添加失败';
		}
	}

	async function submit(e: Event) {
		e.preventDefault();
		await saveCurrentAccount();
	}

	async function identifyAndSaveQuickInput() {
		try {
			quickParsed = parseQuickAzureCredential(quickInput);
			fillQuickToForm(quickParsed);
			await saveCurrentAccount();
		} catch (err) {
			quickParsed = null;
			toast = err instanceof Error ? err.message : '快速识别并保存失败';
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

	async function checkPoolCountAndNotify() {
		checkingPoolCount = true;
		try {
			const result = await api<AccountPoolCheckResult>('/api/user/azure/account/pool/check', {
				method: 'POST'
			});
			await load();
			if (result.notified) {
				toast = `号池剩余 ${result.pool_count} 个账号，已通知 ${result.sent} 个 Telegram 目标${
					result.failed ? `，失败 ${result.failed} 个` : ''
				}`;
			} else {
				toast = `号池剩余 ${result.pool_count} 个账号，Telegram 未通知：${result.notify_error || '没有可用通知目标'}`;
			}
		} catch (err) {
			toast = err instanceof Error ? err.message : '号池剩余数量检测失败';
		} finally {
			checkingPoolCount = false;
		}
	}

	async function checkNormalSubscriptionsAndNotify() {
		checkingNormalSubscriptions = true;
		try {
			const result = await api<AccountNormalNotifyResult>('/api/user/azure/account/pool/normal-notify', {
				method: 'POST'
			});
			if (result.notified) {
				toast = `已检测 ${result.total_count} 个账号，正常 ${result.normal_count} 个，异常 ${result.abnormal_count} 个，检测失败 ${result.check_failed} 个；已通知 ${result.sent} 个 Telegram 目标${
					result.notify_failed ? `，通知失败 ${result.notify_failed} 个` : ''
				}`;
			} else {
				toast = `已检测 ${result.total_count} 个账号，正常 ${result.normal_count} 个，异常 ${result.abnormal_count} 个，检测失败 ${result.check_failed} 个；未通知：${
					result.notify_error || '没有可通知的正常账号'
				}`;
			}
		} catch (err) {
			toast = err instanceof Error ? err.message : '检测正常订阅并通知失败';
		} finally {
			checkingNormalSubscriptions = false;
		}
	}

	onMount(() => {
		void load();
		void loadClientIpProxy();
	});
</script>

<h1 class="mb-4 text-2xl font-semibold">Azure 号池</h1>

{#if toast}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm">{toast}</div>
{/if}

<div class="grid gap-6 lg:grid-cols-2">
	<div class="space-y-4">
	<form class="card space-y-3 p-5" onsubmit={submit}>
		<h2 class="text-lg font-medium">添加账号进入号池</h2>
		<p class="text-sm text-muted">
			默认由部署本网站的服务器直接请求 Azure API，Azure 侧看到的是服务器源站出站 IP。
			选择代理配置后，此账号的验证、VM 查询、开关机和自动补机会走代理出口 IP。保存成功后会向 Telegram 个人和群组播报账号池剩余数量。
		</p>
		<input class="input" bind:value={form.name} placeholder="账号名称，可留空自动生成" />
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
		<button class="btn-primary" type="submit">保存入池</button>
	</form>

	<section class="card space-y-4 p-5">
		<div>
			<h2 class="text-lg font-medium">快速识别 API 信息资料</h2>
			<p class="mt-1 text-sm text-muted">
				粘贴完整资料后会自动识别 Tenant ID、Client ID、Client Secret，并填充到上方三条框。
			</p>
		</div>
		<textarea
			class="input min-h-36 font-mono text-xs"
			bind:value={quickInput}
			placeholder="邮箱|密码|区域-----clientId:azure-cli-name:clientSecret:tenantId"
		></textarea>
		<div class="flex flex-wrap gap-2">
			<button class="btn-secondary" type="button" onclick={identifyQuickInput}>
				识别并填充上方三项
			</button>
			<button class="btn-primary" type="button" onclick={() => void identifyAndSaveQuickInput()}>
				识别并保存入池
			</button>
			<button
				class="btn-secondary"
				type="button"
				onclick={() => {
					quickInput = '';
					quickParsed = null;
				}}
			>
				清空
			</button>
		</div>
		{#if quickParsed}
			<div class="rounded-lg border border-border bg-background p-3 text-xs">
				<div class="font-medium">识别结果</div>
				<div class="mt-2 grid gap-1 sm:grid-cols-2">
					<div>账号: {quickParsed.email || '-'}</div>
					<div>区域: {quickParsed.regions.length ? quickParsed.regions.join(', ') : '-'}</div>
					<div class="break-all">Tenant ID: {quickParsed.tenantId}</div>
					<div class="break-all">Client ID: {quickParsed.clientId}</div>
					<div class="break-all sm:col-span-2">Client Secret: {quickParsed.clientSecret}</div>
				</div>
			</div>
		{/if}
		<p class="text-xs text-muted">
			示例中 `8efbc043...` 会填入 Tenant ID，`5b4d0957...` 会填入 Client ID，`SrW8Q~...` 会填入 Client Secret。
		</p>
	</section>
	</div>

	<div class="card space-y-3 p-5">
		<div class="flex items-center justify-between gap-3">
			<h2 class="text-lg font-medium">Azure 账号池</h2>
			<div class="flex flex-wrap items-center justify-end gap-2">
				<span class="badge bg-primary/10 text-primary">剩余 {accounts.length} 个</span>
				<button
					class="btn-secondary text-xs"
					type="button"
					onclick={() => void checkPoolCountAndNotify()}
					disabled={checkingPoolCount}
				>
					{checkingPoolCount ? '检测通知中...' : '检测剩余并通知'}
				</button>
				<button
					class="btn-primary text-xs"
					type="button"
					onclick={() => void checkNormalSubscriptionsAndNotify()}
					disabled={checkingNormalSubscriptions}
				>
					{checkingNormalSubscriptions ? '检测通知中...' : '检测正常并通知'}
				</button>
			</div>
		</div>
		{#if checkingNormalSubscriptions}
			<div class="progress-track running">
				<div class="progress-fill bg-primary" style="width: 70%"></div>
			</div>
			<p class="text-xs text-muted">正在检测账号订阅是否正常，正常账号将通知 Telegram 个人和群组...</p>
		{/if}
		{#if checkingPoolCount}
			<div class="progress-track running">
				<div class="progress-fill bg-primary" style="width: 65%"></div>
			</div>
			<p class="text-xs text-muted">正在检测 Azure 号池剩余数量并发送 Telegram 通知...</p>
		{/if}
		{#if accounts.length === 0}
			<p class="text-sm text-muted">号池里还没有账号</p>
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
