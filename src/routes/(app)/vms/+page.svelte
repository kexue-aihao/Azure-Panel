<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Account = {
		id: number;
		name: string;
		proxy_enabled?: boolean;
		proxy_name?: string;
		proxy_label?: string;
	};
	type ProxyMode = 'account' | 'direct' | 'client_ip' | 'profile';
	type ProxyProfile = {
		id: number;
		name: string;
		type: 'http' | 'https' | 'socks4' | 'socks4a' | 'socks5' | 'shadowsocks';
		source: 'fixed' | 'client_ip';
		label: string;
	};
	type Vm = {
		name: string;
		resource_group: string;
		location: string;
		vm_size: string;
		power_state: string;
		public_ipv4: string;
		public_ipv6: string;
	};
	type VmCapability = {
		name: string;
		source: string;
		family: string;
		tier: string;
		cores: number;
		memoryGB: number;
		maxDataDiskCount: number;
		acceleratedNetworking: boolean | null;
		hyperVGenerations: string;
		restricted: boolean;
		restrictionReasons: string[];
		quotaName: string;
		quotaLocalizedName: string;
		quotaRemaining: number;
		totalQuotaRemaining: number;
		quotaRequired: number;
		quotaRestricted: boolean;
	};
	type CapabilityResult = {
		location: string;
		available: VmCapability[];
		restricted: VmCapability[];
		quotas: Quota[];
		highest_core_size: VmCapability | null;
		largest_memory_size: VmCapability | null;
	};
	type RegionOption = {
		name: string;
		displayName: string;
		availableSizeCount: number;
		highestCoreSize: VmCapability | null;
		largestMemorySize: VmCapability | null;
	};
	type VmImageOption = {
		label: string;
		imageReference: string;
		publisher: string;
		offer: string;
		sku: string;
		version: string;
		osType: 'Linux' | 'Windows' | 'Unknown';
		architecture: string;
		hyperVGeneration: string;
	};
	type Quota = {
		name: string;
		localizedName: string;
		current: number;
		limit: number;
		remaining: number;
		unit: string;
	};

	let accounts = $state<Account[]>([]);
	let proxies = $state<ProxyProfile[]>([]);
	let vms = $state<Vm[]>([]);
	let regions = $state<RegionOption[]>([]);
	let images = $state<VmImageOption[]>([]);
	let capabilities = $state<CapabilityResult | null>(null);
	let quotas = $state<Quota[]>([]);
	let accountId = $state<number | null>(null);
	let resourceGroup = $state('');
	let location = $state('malaysiawest');
	let loading = $state(false);
	let regionsLoading = $state(false);
	let imagesLoading = $state(false);
	let capabilityLoading = $state(false);
	let quotaLoading = $state(false);
	let createLoading = $state(false);
	let ipActionLoading = $state('');
	let toast = $state('');
	let proxyMode = $state<ProxyMode>('account');
	let proxyProfileId = $state('');
	let brushIpPrefix = $state('85.211');
	let brushMaxAttempts = $state(30);
	let createForm = $state({
		resource_group: '',
		location: 'malaysiawest',
		vm_name: '',
		vm_size: 'Standard_B1s',
		image_reference: 'Canonical:ubuntu-24_04-lts:server:latest',
		admin_username: 'azureuser',
		admin_password: '',
		enable_ipv6: true,
		userdata: '',
		ip_prefix: '',
		ip_brush_max_attempts: 30
	});

	const accountSelectId = 'account-select';
	const proxySelectId = 'vm-proxy-select';
	const proxyProfileSelectId = 'vm-proxy-profile-select';
	const resourceGroupInputId = 'resource-group-input';
	const locationInputId = 'location-input';
	const createLocationSelectId = 'create-location-select';
	const createSizeSelectId = 'create-size-select';
	const imageSelectId = 'image-select';
	const RANDOM_PASSWORD_LENGTH = 12;
	const PASSWORD_LOWER = 'abcdefghijklmnopqrstuvwxyz';
	const PASSWORD_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	const PASSWORD_DIGITS = '0123456789';
	const PASSWORD_CHARS = `${PASSWORD_LOWER}${PASSWORD_UPPER}${PASSWORD_DIGITS}`;

	function randomIndex(max: number) {
		const values = new Uint32Array(1);
		globalThis.crypto?.getRandomValues(values);
		return (values[0] || Math.floor(Math.random() * max)) % max;
	}

	function randomChar(chars: string) {
		return chars[randomIndex(chars.length)];
	}

	function generateAdminPassword(length = RANDOM_PASSWORD_LENGTH) {
		const chars = [
			randomChar(PASSWORD_LOWER),
			randomChar(PASSWORD_UPPER),
			randomChar(PASSWORD_DIGITS)
		];
		while (chars.length < length) chars.push(randomChar(PASSWORD_CHARS));

		for (let i = chars.length - 1; i > 0; i--) {
			const j = randomIndex(i + 1);
			[chars[i], chars[j]] = [chars[j], chars[i]];
		}

		return chars.join('');
	}

	function randomName(prefix: string, maxLength = 48) {
		const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const available = Math.max(maxLength - suffix.length - 1, 1);
		return `${prefix.slice(0, available)}-${suffix}`;
	}

	function refreshCreateNames() {
		createForm.resource_group = randomName('rg-azp', 64);
		createForm.vm_name = randomName('vm-azp', 48);
	}

	function refreshAdminPassword() {
		createForm.admin_password = generateAdminPassword();
	}

	let fixedProxies = $derived(proxies.filter((proxy) => proxy.source === 'fixed'));
	let clientIpProxy = $derived(proxies.find((proxy) => proxy.source === 'client_ip') ?? null);
	let selectedAccount = $derived(accounts.find((account) => account.id === accountId) ?? null);

	function syncProxySelection() {
		if (proxyMode !== 'profile') {
			proxyProfileId = '';
			return;
		}

		if (fixedProxies.length === 0) {
			proxyMode = 'account';
			proxyProfileId = '';
			return;
		}

		if (!fixedProxies.some((proxy) => String(proxy.id) === proxyProfileId)) {
			proxyProfileId = fixedProxies[0] ? String(fixedProxies[0].id) : '';
		}
	}

	function appendProxyParams(params: URLSearchParams) {
		params.set('proxy_mode', proxyMode);
		if (proxyMode === 'profile' && proxyProfileId) {
			params.set('proxy_profile_id', proxyProfileId);
		}
		return params;
	}

	function proxyPayload() {
		return {
			proxy_mode: proxyMode,
			proxy_profile_id: proxyMode === 'profile' ? proxyProfileId : ''
		};
	}

	async function changeProxySelection() {
		syncProxySelection();
		if (accountId) {
			capabilities = null;
			quotas = [];
			images = [];
			const loadedRegions = await loadRegions();
			if (loadedRegions) {
				await Promise.all([loadVms(), loadRegionDetails()]);
			} else {
				await loadVms();
			}
		}
	}

	async function loadAccounts() {
		const [accountList, proxyList] = await Promise.all([
			api<Account[]>('/api/user/azure/account/list'),
			api<ProxyProfile[]>('/api/user/proxy/list')
		]);
		accounts = accountList;
		proxies = proxyList;
		syncProxySelection();
		if (!accountId && accounts.length) accountId = accounts[0].id;
	}

	async function loadRegions() {
		if (!accountId) {
			regions = [];
			return false;
		}

		regionsLoading = true;
		try {
			const params = new URLSearchParams({ account_id: String(accountId) });
			appendProxyParams(params);
			regions = await api<RegionOption[]>(`/api/user/azure/region/list?${params}`);
			if (regions.length === 0) {
				location = '';
				createForm.location = '';
				toast = '当前账号没有识别到 Azure 返回的 VM 区域';
				return false;
			}
			if (regions.length && !regions.some((region) => region.name === location)) {
				location = regions[0].name;
			}
			createForm.location = location;
			toast = `已识别 ${regions.length} 个当前账号可开机区域`;
			return true;
		} catch (err) {
			regions = [];
			toast = err instanceof Error ? err.message : '区域查询失败';
			return false;
		} finally {
			regionsLoading = false;
		}
	}

	async function loadVms() {
		if (!accountId) {
			vms = [];
			return;
		}

		loading = true;
		try {
			const params = new URLSearchParams({ account_id: String(accountId) });
			if (resourceGroup) params.set('resource_group', resourceGroup);
			appendProxyParams(params);
			vms = await api<Vm[]>(`/api/user/azure/resource/list?${params}`);
		} catch (err) {
			toast = err instanceof Error ? err.message : '加载失败';
		} finally {
			loading = false;
		}
	}

	async function loadCapabilities() {
		if (!accountId || !location.trim()) return;
		capabilityLoading = true;
		createForm.vm_size = '';
		try {
			const params = new URLSearchParams({
				account_id: String(accountId),
				location: location.trim()
			});
			appendProxyParams(params);
			capabilities = await api<CapabilityResult>(`/api/user/azure/capability/list?${params}`);
			quotas = capabilities.quotas ?? [];
			if (
				capabilities.available.length &&
				!capabilities.available.some((item) => item.name === createForm.vm_size)
			) {
				createForm.vm_size = capabilities.available[0].name;
			}
			if (capabilities.available.length === 0) {
				createForm.vm_size = '';
			}
			toast = `已识别 ${capabilities.available.length} 个 ${location} 可用规格`;
		} catch (err) {
			capabilities = null;
			createForm.vm_size = '';
			toast = err instanceof Error ? err.message : '规格查询失败';
		} finally {
			capabilityLoading = false;
		}
	}

	async function loadImages() {
		if (!accountId || !location.trim()) return;
		imagesLoading = true;
		try {
			const params = new URLSearchParams({
				account_id: String(accountId),
				location: location.trim()
			});
			appendProxyParams(params);
			images = await api<VmImageOption[]>(`/api/user/azure/image/list?${params}`);
			if (images.length && !images.some((item) => item.imageReference === createForm.image_reference)) {
				createForm.image_reference = images[0].imageReference;
			}
			toast = `已加载 ${images.length} 个 ${location} 可安装系统`;
		} catch (err) {
			images = [];
			toast = err instanceof Error ? err.message : '系统镜像查询失败';
		} finally {
			imagesLoading = false;
		}
	}

	async function loadQuotas() {
		if (!accountId || !location.trim()) return;
		quotaLoading = true;
		try {
			const params = new URLSearchParams({
				account_id: String(accountId),
				location: location.trim()
			});
			appendProxyParams(params);
			quotas = await api<Quota[]>(`/api/user/azure/quota/list?${params}`);
			toast = `已加载 ${location} 区域配额`;
		} catch (err) {
			toast = err instanceof Error ? err.message : '配额查询失败';
		} finally {
			quotaLoading = false;
		}
	}

	async function loadRegionDetails() {
		createForm.location = location;
		capabilities = null;
		quotas = [];
		images = [];
		createForm.vm_size = '';
		await Promise.all([loadCapabilities(), loadImages()]);
	}

	async function changeAccount() {
		refreshAdminPassword();
		refreshCreateNames();
		syncProxySelection();
		capabilities = null;
		quotas = [];
		images = [];
		const loadedRegions = await loadRegions();
		if (loadedRegions) {
			await Promise.all([loadVms(), loadRegionDetails()]);
		} else {
			await loadVms();
		}
	}

	async function changeLocation() {
		refreshAdminPassword();
		refreshCreateNames();
		await loadRegionDetails();
	}

	async function createVm(e: Event) {
		e.preventDefault();
		if (!accountId) return;
		createForm.location = location;
		if (!capabilities?.available.some((item) => item.name === createForm.vm_size)) {
			toast = '请先从 Azure 查询并选择当前区域规格';
			return;
		}
		if (!images.some((item) => item.imageReference === createForm.image_reference)) {
			toast = '请先从 Azure 查询并选择当前区域可安装的系统镜像';
			return;
		}
		createLoading = true;
		try {
			refreshCreateNames();
			const result = await api<{
				name: string;
				resource_group: string;
				public_ipv4: string;
				public_ipv6: string;
				ip_brush_attempts: number;
			}>('/api/user/azure/vm/create', {
				method: 'POST',
				body: JSON.stringify({
					...createForm,
					account_id: accountId,
					...proxyPayload(),
					ip_brush_max_attempts: Number(createForm.ip_brush_max_attempts)
				})
			});
			toast = `VM ${result.name} 创建完成，IPv4=${result.public_ipv4 || '-'} IPv6=${result.public_ipv6 || '-'}，刷IP次数=${result.ip_brush_attempts}`;
			resourceGroup = result.resource_group;
			refreshCreateNames();
			refreshAdminPassword();
			await loadVms();
		} catch (err) {
			toast = err instanceof Error ? err.message : '创建失败';
		} finally {
			createLoading = false;
		}
	}

	async function power(action: 'on' | 'off' | 'restart', vm: Vm) {
		if (!accountId) return;
		try {
			await api(`/api/user/azure/vm/power/${action}`, {
				method: 'POST',
				body: JSON.stringify({
					account_id: accountId,
					...proxyPayload(),
					resource_group: vm.resource_group,
					vm_name: vm.name
				})
			});
			toast = `已触发 ${vm.name} 操作`;
			setTimeout(() => {
				void loadVms();
			}, 1500);
		} catch (err) {
			toast = err instanceof Error ? err.message : '操作失败';
		}
	}

	async function replaceIp(vm: Vm) {
		if (!accountId) return;
		if (!confirm(`确认给 ${vm.name} 更换公网 IPv4 吗？此操作可能造成短暂网络中断。`)) return;
		ipActionLoading = `${vm.name}:replace`;
		try {
			const result = await api<{ public_ipv4: string; old_public_ipv4: string }>(
				'/api/user/azure/vm/ip/replace',
				{
					method: 'POST',
					body: JSON.stringify({
						account_id: accountId,
						...proxyPayload(),
						resource_group: vm.resource_group,
						vm_name: vm.name
					})
				}
			);
			toast = `${vm.name} 已更换 IPv4：${result.old_public_ipv4 || '-'} -> ${result.public_ipv4 || '-'}`;
			await loadVms();
		} catch (err) {
			toast = err instanceof Error ? err.message : '换 IP 失败';
		} finally {
			ipActionLoading = '';
		}
	}

	async function brushIp(vm: Vm) {
		if (!accountId) return;
		if (!brushIpPrefix.trim()) {
			toast = '请填写要匹配的 IPv4 前缀';
			return;
		}
		const ok = confirm(
			`确认给 ${vm.name} 刷 IPv4 前缀 ${brushIpPrefix} 吗？最多尝试 ${brushMaxAttempts} 次，成功后自动停止。`
		);
		if (!ok) return;
		ipActionLoading = `${vm.name}:brush`;
		try {
			const result = await api<{ public_ipv4: string; attempts: number }>(
				'/api/user/azure/vm/ip/brush',
				{
					method: 'POST',
					body: JSON.stringify({
						account_id: accountId,
						...proxyPayload(),
						resource_group: vm.resource_group,
						vm_name: vm.name,
						ip_prefix: brushIpPrefix,
						max_attempts: Number(brushMaxAttempts)
					})
				}
			);
			toast = `${vm.name} 已匹配 IPv4 ${result.public_ipv4}，尝试 ${result.attempts} 次`;
			await loadVms();
		} catch (err) {
			toast = err instanceof Error ? err.message : '刷 IP 失败';
		} finally {
			ipActionLoading = '';
		}
	}

	function badge(state: string) {
		if (state === 'running' || state === 'starting') return 'bg-green-900/50 text-green-300';
		if (state === 'deallocated' || state === 'stopped') return 'bg-red-900/50 text-red-300';
		return 'bg-yellow-900/50 text-yellow-300';
	}

	function fillCreateFromCapability(size: string) {
		createForm.vm_size = size;
	}

	onMount(async () => {
		refreshAdminPassword();
		refreshCreateNames();
		await loadAccounts();
		if (accountId) {
			await loadRegions();
			await Promise.all([loadVms(), loadRegionDetails()]);
		}
	});
</script>

<h1 class="mb-4 text-2xl font-semibold">VM 管理</h1>

{#if toast}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm">{toast}</div>
{/if}

<div class="mb-4 grid gap-4 xl:grid-cols-[1fr_1.2fr]">
	<div class="card space-y-4 p-5">
		<div class="flex flex-wrap items-end gap-3">
			<div>
				<label class="text-sm text-muted" for={accountSelectId}>Azure 账号</label>
				<select
					id={accountSelectId}
					class="input mt-1 min-w-[220px]"
					bind:value={accountId}
					onchange={() => void changeAccount()}
				>
					<option value={null}>选择账号</option>
					{#each accounts as account}
						<option value={account.id}>{account.name}</option>
					{/each}
				</select>
			</div>
			<div>
				<label class="text-sm text-muted" for={proxySelectId}>本次操作代理</label>
				<select
					id={proxySelectId}
					class="input mt-1 min-w-[260px]"
					bind:value={proxyMode}
					onchange={() => void changeProxySelection()}
				>
					<option value="account">
						沿用账号绑定{selectedAccount?.proxy_enabled
							? `：${selectedAccount.proxy_name ? `${selectedAccount.proxy_name} ` : ''}${selectedAccount.proxy_label}`
							: '：服务器源站 IP'}
					</option>
					<option value="direct">强制直连：服务器源站 IP</option>
					<option value="client_ip">当前访问网站 IP 自动代理</option>
					<option value="profile" disabled={fixedProxies.length === 0}>选择已保存代理</option>
				</select>
			</div>
			{#if proxyMode === 'profile'}
				<div>
					<label class="text-sm text-muted" for={proxyProfileSelectId}>代理档案</label>
					<select
						id={proxyProfileSelectId}
						class="input mt-1 min-w-[300px]"
						bind:value={proxyProfileId}
						onchange={() => void changeProxySelection()}
						disabled={fixedProxies.length === 0}
					>
						{#if fixedProxies.length === 0}
							<option value="">请先到代理配置添加代理</option>
						{:else}
							{#each fixedProxies as proxy}
								<option value={String(proxy.id)}>{proxy.name} - {proxy.label}</option>
							{/each}
						{/if}
					</select>
				</div>
			{:else if proxyMode === 'client_ip'}
				<div class="max-w-sm rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted">
					{#if clientIpProxy}
						当前将使用：{clientIpProxy.name} - {clientIpProxy.label}
					{:else}
						会自动识别当前访问网站的 IP 并尝试创建可用代理档案
					{/if}
				</div>
			{/if}
			<div>
				<label class="text-sm text-muted" for={resourceGroupInputId}>资源组（可选）</label>
				<input
					id={resourceGroupInputId}
					class="input mt-1"
					bind:value={resourceGroup}
					placeholder="my-rg"
				/>
			</div>
			<div>
				<label class="text-sm text-muted" for={locationInputId}>区域</label>
				<select
					id={locationInputId}
					class="input mt-1 min-w-[220px]"
					bind:value={location}
					onchange={() => void changeLocation()}
					disabled={regionsLoading || regions.length === 0}
				>
					{#if regionsLoading}
						<option value={location}>正在识别可开机区域...</option>
					{:else if regions.length === 0}
						<option value={location}>请先选择账号并加载区域</option>
					{:else}
						{#each regions as region}
							<option value={region.name}>
								{region.displayName} ({region.name}) · {region.availableSizeCount} 个规格
							</option>
						{/each}
					{/if}
				</select>
			</div>
			<button class="btn-primary" onclick={() => void loadVms()} disabled={loading}>刷新 VM</button>
		</div>

		<div class="grid gap-3 md:grid-cols-3">
			<button class="btn-secondary" onclick={() => void loadRegions()} disabled={regionsLoading}>
				{regionsLoading ? '识别区域中...' : '重新识别区域'}
			</button>
			<button class="btn-secondary" onclick={() => void loadCapabilities()} disabled={capabilityLoading}>
				{capabilityLoading ? '查询中...' : '查询区域规格'}
			</button>
			<button class="btn-secondary" onclick={() => void loadQuotas()} disabled={quotaLoading}>
				{quotaLoading ? '查询中...' : '查询区域配额'}
			</button>
		</div>

		{#if capabilities}
			<div class="rounded-lg border border-border p-3 text-sm">
				<div class="font-medium">账号可用规格</div>
				<p class="mt-1 text-xs text-muted">
					最高核心数：{capabilities.highest_core_size?.name ?? '-'} · 最大内存：{capabilities.largest_memory_size?.name ?? '-'}
				</p>
				<div class="mt-3 max-h-72 overflow-auto">
					<table class="w-full text-xs">
						<thead class="text-muted">
							<tr class="border-b border-border">
								<th class="p-2 text-left">规格</th>
								<th class="p-2 text-left">vCPU</th>
								<th class="p-2 text-left">内存GB</th>
								<th class="p-2 text-left">操作</th>
							</tr>
						</thead>
						<tbody>
							{#each [...capabilities.available].reverse() as item}
								<tr class="border-b border-border/60">
									<td class="p-2">{item.name}</td>
									<td class="p-2">{item.cores}</td>
									<td class="p-2">{item.memoryGB}</td>
									<td class="p-2">
										<button class="btn-secondary px-2 py-1 text-xs" onclick={() => fillCreateFromCapability(item.name)}>
											填入
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/if}

		{#if quotas.length}
			<div class="rounded-lg border border-border p-3 text-sm">
				<div class="font-medium">Compute 配额</div>
				<div class="mt-3 max-h-72 overflow-auto">
					<table class="w-full text-xs">
						<thead class="text-muted">
							<tr class="border-b border-border">
								<th class="p-2 text-left">项目</th>
								<th class="p-2 text-left">已用</th>
								<th class="p-2 text-left">上限</th>
								<th class="p-2 text-left">剩余</th>
							</tr>
						</thead>
						<tbody>
							{#each quotas as quota}
								<tr class="border-b border-border/60">
									<td class="p-2">{quota.localizedName || quota.name}</td>
									<td class="p-2">{quota.current}</td>
									<td class="p-2">{quota.limit}</td>
									<td class="p-2">{quota.remaining}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/if}
	</div>

	<form class="card space-y-3 p-5" onsubmit={createVm}>
		<div>
			<h2 class="text-lg font-medium">创建 VM</h2>
			<p class="mt-1 text-sm text-muted">
				创建时会自动随机生成资源组和 VM 名称，默认可同时创建 IPv4/IPv6，UserData 会作为 cloud-init 首次启动脚本注入。填写 IPv4 前缀后会先刷到匹配公网 IP 再建机。
			</p>
		</div>
		<div class="grid gap-3 md:grid-cols-2">
			<div class="rounded-lg border border-border bg-background px-3 py-2 text-sm">
				<div class="text-xs text-muted">本次将自动创建资源组</div>
				<div class="mt-1 font-mono">{createForm.resource_group}</div>
			</div>
			<div>
				<label class="mb-1 block text-xs text-muted" for={createLocationSelectId}>创建区域</label>
				<select
					id={createLocationSelectId}
					class="input"
					bind:value={location}
					onchange={() => void changeLocation()}
					disabled={regionsLoading || regions.length === 0}
					required
				>
					{#if regionsLoading}
						<option value={location}>正在识别可开机区域...</option>
					{:else if regions.length === 0}
						<option value={createForm.location}>请先加载可开机区域</option>
					{:else}
						{#each regions as region}
							<option value={region.name}>
								{region.displayName} ({region.name}) · 最大 {region.highestCoreSize?.name ?? '-'}
							</option>
						{/each}
					{/if}
				</select>
			</div>
			<div class="rounded-lg border border-border bg-background px-3 py-2 text-sm">
				<div class="text-xs text-muted">本次 VM 名称</div>
				<div class="mt-1 font-mono">{createForm.vm_name}</div>
			</div>
			<div>
				<label class="mb-1 block text-xs text-muted" for={createSizeSelectId}>实例规格</label>
				<select
					id={createSizeSelectId}
					class="input"
					bind:value={createForm.vm_size}
					disabled={capabilityLoading || !capabilities?.available.length}
					required
				>
					{#if capabilityLoading}
						<option value={createForm.vm_size}>正在从 Azure 查询规格...</option>
					{:else if capabilities?.available.length}
						{#each capabilities.available as item}
							<option value={item.name}>
								{item.name} · {item.cores} vCPU · {item.memoryGB}GB
							</option>
						{/each}
					{:else}
						<option value={createForm.vm_size}>请先选择区域并查询规格</option>
					{/if}
				</select>
			</div>
		</div>
		<div>
			<label class="mb-1 block text-xs text-muted" for={imageSelectId}>安装系统</label>
			<select
				id={imageSelectId}
				class="input"
				bind:value={createForm.image_reference}
				disabled={imagesLoading || images.length === 0}
				required
			>
				{#if imagesLoading}
					<option value={createForm.image_reference}>正在从 Azure 查询可安装系统...</option>
				{:else if images.length}
					{#each images as image}
						<option value={image.imageReference}>
							{image.label} · {image.osType}{image.architecture ? ` · ${image.architecture}` : ''}{image.hyperVGeneration
								? ` · ${image.hyperVGeneration}`
								: ''}
						</option>
					{/each}
				{:else}
					<option value={createForm.image_reference}>请先选择区域并加载系统镜像</option>
				{/if}
			</select>
			<p class="mt-1 break-all text-xs text-muted">{createForm.image_reference}</p>
		</div>
		<div class="grid gap-3 md:grid-cols-2">
			<input class="input" bind:value={createForm.admin_username} placeholder="管理员用户名" required />
			<div class="grid gap-2 sm:grid-cols-[1fr_auto]">
				<input
					class="input font-mono"
					type="text"
					bind:value={createForm.admin_password}
					minlength={RANDOM_PASSWORD_LENGTH}
					autocomplete="off"
					spellcheck="false"
					placeholder="管理员密码"
					required
				/>
				<button class="btn-secondary whitespace-nowrap" type="button" onclick={refreshAdminPassword}>
					更换随机密码
				</button>
			</div>
		</div>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={createForm.enable_ipv6} /> 同时创建 IPv6 公网地址
		</label>
		<div class="grid gap-3 md:grid-cols-2">
			<input
				class="input"
				bind:value={createForm.ip_prefix}
				placeholder="目标 IPv4 前缀，可选，例如 85.211"
			/>
			<input
				class="input"
				type="number"
				min="1"
				max="500"
				bind:value={createForm.ip_brush_max_attempts}
				placeholder="最大刷 IP 次数"
			/>
		</div>
		<textarea
			class="input min-h-36 font-mono text-xs"
			bind:value={createForm.userdata}
			placeholder={`#cloud-config\nruncmd:\n  - curl -fsSL https://example.com/install.sh | bash`}
		></textarea>
		<button
			class="btn-primary"
			type="submit"
			disabled={createLoading || capabilityLoading || imagesLoading || !capabilities?.available.length || !images.length}
		>
			{createLoading ? '创建中...' : '创建 VM'}
		</button>
	</form>
</div>

<div class="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
	<div>
		<label class="text-sm text-muted" for="brush-prefix">刷 IPv4 前缀</label>
		<input id="brush-prefix" class="input mt-1" bind:value={brushIpPrefix} placeholder="85.211" />
	</div>
	<div>
		<label class="text-sm text-muted" for="brush-attempts">最大次数</label>
		<input
			id="brush-attempts"
			class="input mt-1"
			type="number"
			min="1"
			max="500"
			bind:value={brushMaxAttempts}
		/>
	</div>
	<p class="text-sm text-muted">
		刷 IP 会重复创建并检测公网 IPv4，命中前缀后自动停止；未命中会删除临时 IP 并在达到最大次数后停止。
	</p>
</div>

<div class="card overflow-x-auto">
	<table class="w-full text-sm">
		<thead class="text-muted">
			<tr class="border-b border-border">
				<th class="p-3 text-left">名称</th>
				<th class="p-3 text-left">资源组</th>
				<th class="p-3 text-left">区域</th>
				<th class="p-3 text-left">规格</th>
				<th class="p-3 text-left">公网 IP</th>
				<th class="p-3 text-left">状态</th>
				<th class="p-3 text-left">操作</th>
			</tr>
		</thead>
		<tbody>
			{#if vms.length === 0}
				<tr>
					<td class="p-3 text-muted" colspan="7">暂无 VM</td>
				</tr>
			{:else}
				{#each vms as vm}
					<tr class="border-b border-border/60">
						<td class="p-3">{vm.name}</td>
						<td class="p-3">{vm.resource_group}</td>
						<td class="p-3">{vm.location}</td>
						<td class="p-3">{vm.vm_size}</td>
						<td class="p-3">
							<div>{vm.public_ipv4 || '-'}</div>
							<div class="text-xs text-muted">{vm.public_ipv6 || '-'}</div>
						</td>
						<td class="p-3">
							<span class={`badge ${badge(vm.power_state)}`}>{vm.power_state}</span>
						</td>
						<td class="space-x-2 whitespace-nowrap p-3">
							<button class="btn-primary" onclick={() => void power('on', vm)}>开机</button>
							<button class="btn-secondary" onclick={() => void power('off', vm)}>关机</button>
							<button class="btn-secondary" onclick={() => void power('restart', vm)}>重启</button>
							<button
								class="btn-secondary"
								onclick={() => void replaceIp(vm)}
								disabled={ipActionLoading === `${vm.name}:replace`}
							>
								换 IPv4
							</button>
							<button
								class="btn-secondary"
								onclick={() => void brushIp(vm)}
								disabled={ipActionLoading === `${vm.name}:brush`}
							>
								刷 IPv4 段
							</button>
						</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>
