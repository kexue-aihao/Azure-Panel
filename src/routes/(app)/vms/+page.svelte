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
	type Quota = {
		name: string;
		localizedName: string;
		current: number;
		limit: number;
		remaining: number;
		unit: string;
	};
	type VmSizeOption = {
		name: string;
		cores: number;
		memory_gb: number;
		max_data_disk_count: number;
		quota_localized_name: string;
		quota_remaining: number;
		quota_required: number;
		source: string;
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
	type FirewallRule = {
		name: string;
		description: string;
		protocol: string;
		sourcePortRange: string;
		destinationPortRange: string;
		sourceAddressPrefix: string;
		destinationAddressPrefix: string;
		access: string;
		priority: number;
		direction: string;
		provisioningState: string;
	};
	type FirewallRuleResponse = {
		networkSecurityGroup: string;
		networkSecurityGroupResourceGroup: string;
		rules: FirewallRule[];
	};
	type CreateProgressStatus = 'running' | 'success' | 'error' | 'info';
	type CreateProgressEvent = {
		step: string;
		status: CreateProgressStatus;
		message: string;
		detail?: Record<string, string | number | boolean | null>;
		timestamp: string;
	};
	type CreateStreamMessage =
		| { type: 'progress'; event: CreateProgressEvent }
		| {
				type: 'result';
				result: {
					name: string;
					resource_group: string;
					location: string;
					public_ipv4: string;
					public_ipv6: string;
					ip_brush_attempts: number;
					ip_brush_matched: boolean;
				};
		  }
		| { type: 'error'; message: string };

	let accounts = $state<Account[]>([]);
	let proxies = $state<ProxyProfile[]>([]);
	let vms = $state<Vm[]>([]);
	let quotas = $state<Quota[]>([]);
	let vmSizes = $state<VmSizeOption[]>([]);
	let vmImages = $state<VmImageOption[]>([]);
	let accountId = $state<number | null>(null);
	let resourceGroup = $state('');
	let location = $state('malaysiawest');
	let loading = $state(false);
	let quotaLoading = $state(false);
	let sizeLoading = $state(false);
	let imageLoading = $state(false);
	let createLoading = $state(false);
	let ipActionLoading = $state('');
	let firewallLoading = $state(false);
	let firewallActionLoading = $state('');
	let toast = $state('');
	let sizeError = $state('');
	let imageError = $state('');
	let createProgress = $state<CreateProgressEvent[]>([]);
	let firewallVm = $state<Vm | null>(null);
	let firewallRules = $state<FirewallRule[]>([]);
	let firewallNsg = $state('');
	let firewallNsgResourceGroup = $state('');
	let proxyMode = $state<ProxyMode>('account');
	let proxyProfileId = $state('');
	let brushIpPrefix = $state('85.211');
	let brushMaxAttempts = $state(30);
	let firewallForm = $state({
		name: '',
		protocol: 'Tcp',
		source_port_range: '*',
		destination_port_range: '22',
		source_address_prefix: '*',
		destination_address_prefix: '*',
		access: 'Allow',
		priority: 1000,
		direction: 'Inbound',
		description: ''
	});
	let createForm = $state({
		resource_group: '',
		location: 'malaysiawest',
		vm_name: '',
		vm_size: 'Standard_B1s',
		image_reference: 'Canonical:ubuntu-24_04-lts:server:latest',
		admin_username: 'azureuser',
		admin_password: '',
		enable_ipv6: true,
		open_ports: '*',
		enable_ddos_protection: false,
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
	let createOptionsRequestId = 0;

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

	function mergeCreateProgress(event: CreateProgressEvent) {
		const index = createProgress.findIndex((item) => item.step === event.step);
		if (index === -1) {
			createProgress = [...createProgress, event];
			return;
		}
		createProgress = createProgress.map((item, itemIndex) =>
			itemIndex === index ? { ...item, ...event } : item
		);
	}

	function progressBadge(status: CreateProgressStatus) {
		if (status === 'success') return 'bg-green-900/50 text-green-300';
		if (status === 'error') return 'bg-red-900/50 text-red-300';
		if (status === 'info') return 'bg-blue-900/50 text-blue-300';
		return 'bg-yellow-900/50 text-yellow-300';
	}

	function progressText(status: CreateProgressStatus) {
		if (status === 'success') return '完成';
		if (status === 'error') return '失败';
		if (status === 'info') return '信息';
		return '进行中';
	}

	function progressDetail(detail?: CreateProgressEvent['detail']) {
		if (!detail) return '';
		return Object.entries(detail)
			.filter(([, value]) => value !== undefined && value !== null && value !== '')
			.map(([key, value]) => `${key}: ${String(value)}`)
			.join('，');
	}

	async function createVmWithProgress(payload: Record<string, unknown>) {
		const token = localStorage.getItem('token');
		const response = await fetch('/api/user/azure/vm/create', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/x-ndjson',
				...(token ? { Authorization: `Bearer ${token}` } : {})
			},
			body: JSON.stringify(payload)
		});
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			throw new Error(body?.message ?? `创建请求失败 (${response.status})`);
		}
		if (!response.body) throw new Error('浏览器不支持读取创建进度流');

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let result: Extract<CreateStreamMessage, { type: 'result' }>['result'] | null = null;

		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				const message = JSON.parse(line) as CreateStreamMessage;
				if (message.type === 'progress') {
					mergeCreateProgress(message.event);
				} else if (message.type === 'result') {
					result = message.result;
				} else if (message.type === 'error') {
					throw new Error(message.message);
				}
			}
			if (done) break;
		}
		if (!result) throw new Error('创建流程结束但未返回 VM 结果');
		return result;
	}

	async function changeProxySelection() {
		syncProxySelection();
		if (accountId) {
			await Promise.all([loadVms(), loadRegionDetails()]);
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

	function syncCreateLocation() {
		createForm.location = location;
	}

	function sizeLabel(size: VmSizeOption) {
		const memory = Number.isFinite(size.memory_gb) ? `${size.memory_gb} GB` : '-';
		const quota =
			size.quota_remaining || size.quota_required
				? `，剩余 ${size.quota_remaining}/${size.quota_required} vCPU`
				: '';
		return `${size.name}（${size.cores}C / ${memory}${quota}）`;
	}

	function imageLabel(image: VmImageOption) {
		const meta = [image.osType, image.architecture, image.hyperVGeneration]
			.filter(Boolean)
			.join(' / ');
		return meta ? `${image.label} - ${meta}` : image.label;
	}

	async function loadVmSizes(requestId: number) {
		if (!accountId || !location.trim()) {
			vmSizes = [];
			sizeLoading = false;
			sizeError = '';
			return;
		}
		sizeLoading = true;
		sizeError = '';
		try {
			const params = new URLSearchParams({
				account_id: String(accountId),
				location: location.trim()
			});
			appendProxyParams(params);
			const result = await api<{ sizes: VmSizeOption[] }>(`/api/user/azure/vm/sizes?${params}`);
			if (requestId !== createOptionsRequestId) return;
			vmSizes = result.sizes ?? [];
			if (vmSizes.length && !vmSizes.some((size) => size.name === createForm.vm_size)) {
				createForm.vm_size = vmSizes[0].name;
			}
		} catch (err) {
			if (requestId !== createOptionsRequestId) return;
			vmSizes = [];
			sizeError = err instanceof Error ? err.message : '规格查询失败';
		} finally {
			if (requestId === createOptionsRequestId) sizeLoading = false;
		}
	}

	async function loadVmImages(requestId: number) {
		if (!accountId || !location.trim()) {
			vmImages = [];
			imageLoading = false;
			imageError = '';
			return;
		}
		imageLoading = true;
		imageError = '';
		try {
			const params = new URLSearchParams({
				account_id: String(accountId),
				location: location.trim()
			});
			appendProxyParams(params);
			const images = await api<VmImageOption[]>(`/api/user/azure/image/list?${params}`);
			if (requestId !== createOptionsRequestId) return;
			vmImages = images ?? [];
			if (
				vmImages.length &&
				!vmImages.some((image) => image.imageReference === createForm.image_reference)
			) {
				createForm.image_reference = vmImages[0].imageReference;
			}
		} catch (err) {
			if (requestId !== createOptionsRequestId) return;
			vmImages = [];
			imageError = err instanceof Error ? err.message : '系统镜像查询失败';
		} finally {
			if (requestId === createOptionsRequestId) imageLoading = false;
		}
	}

	async function loadCreateOptions() {
		syncCreateLocation();
		const requestId = ++createOptionsRequestId;
		await Promise.all([loadVmSizes(requestId), loadVmImages(requestId)]);
	}

	async function loadRegionDetails() {
		syncCreateLocation();
		quotas = [];
		await Promise.all([loadQuotas(), loadCreateOptions()]);
	}

	async function changeAccount() {
		refreshAdminPassword();
		refreshCreateNames();
		syncProxySelection();
		await Promise.all([loadVms(), loadRegionDetails()]);
	}

	async function changeLocation() {
		refreshAdminPassword();
		refreshCreateNames();
		await loadRegionDetails();
	}

	async function createVm(e: Event) {
		e.preventDefault();
		if (!accountId) return;
		syncCreateLocation();
		if (!createForm.location.trim() || !createForm.vm_size.trim() || !createForm.image_reference.trim()) {
			toast = '请填写区域、实例规格和系统镜像';
			return;
		}
		if (!vmSizes.some((size) => size.name === createForm.vm_size)) {
			toast = '请先从 Azure 官方 API 返回的实例规格下拉列表中选择规格';
			return;
		}
		if (!vmImages.some((image) => image.imageReference === createForm.image_reference)) {
			toast = '请先从 Azure 官方 API 返回的安装系统下拉列表中选择系统';
			return;
		}
		createLoading = true;
		createProgress = [];
		try {
			refreshCreateNames();
			const result = await createVmWithProgress({
				...createForm,
				account_id: accountId,
				...proxyPayload(),
				ip_brush_max_attempts: Number(createForm.ip_brush_max_attempts)
			});
			toast = `VM ${result.name} 创建完成，IPv4=${result.public_ipv4 || '-'} IPv6=${result.public_ipv6 || '-'}，刷IP次数=${result.ip_brush_attempts}`;
			resourceGroup = result.resource_group;
			refreshCreateNames();
			refreshAdminPassword();
			await loadVms();
		} catch (err) {
			const message = err instanceof Error ? err.message : '创建失败';
			mergeCreateProgress({
				step: 'failed',
				status: 'error',
				message,
				timestamp: new Date().toISOString()
			});
			toast = message;
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

	function resetFirewallForm() {
		firewallForm = {
			name: '',
			protocol: 'Tcp',
			source_port_range: '*',
			destination_port_range: '22',
			source_address_prefix: '*',
			destination_address_prefix: '*',
			access: 'Allow',
			priority: 1000,
			direction: 'Inbound',
			description: ''
		};
	}

	function editFirewallRule(rule: FirewallRule) {
		firewallForm = {
			name: rule.name,
			protocol: rule.protocol || '*',
			source_port_range: rule.sourcePortRange || '*',
			destination_port_range: rule.destinationPortRange || '*',
			source_address_prefix: rule.sourceAddressPrefix || '*',
			destination_address_prefix: rule.destinationAddressPrefix || '*',
			access: rule.access || 'Allow',
			priority: rule.priority || 1000,
			direction: rule.direction || 'Inbound',
			description: rule.description || ''
		};
	}

	async function loadFirewallRules(vm = firewallVm) {
		if (!accountId || !vm) return;
		firewallLoading = true;
		try {
			const params = new URLSearchParams({
				account_id: String(accountId),
				resource_group: vm.resource_group,
				vm_name: vm.name
			});
			appendProxyParams(params);
			const result = await api<FirewallRuleResponse>(`/api/user/azure/vm/firewall?${params}`);
			firewallVm = vm;
			firewallRules = result.rules ?? [];
			firewallNsg = result.networkSecurityGroup;
			firewallNsgResourceGroup = result.networkSecurityGroupResourceGroup;
			toast = `已加载 ${vm.name} 防火墙策略`;
		} catch (err) {
			toast = err instanceof Error ? err.message : '防火墙策略加载失败';
		} finally {
			firewallLoading = false;
		}
	}

	async function openFirewall(vm: Vm) {
		resetFirewallForm();
		firewallVm = vm;
		firewallRules = [];
		firewallNsg = '';
		firewallNsgResourceGroup = '';
		await loadFirewallRules(vm);
	}

	async function saveFirewallRule(e: Event) {
		e.preventDefault();
		if (!accountId || !firewallVm) return;
		firewallActionLoading = 'save';
		try {
			await api<FirewallRule>('/api/user/azure/vm/firewall', {
				method: 'POST',
				body: JSON.stringify({
					account_id: accountId,
					...proxyPayload(),
					resource_group: firewallVm.resource_group,
					vm_name: firewallVm.name,
					...firewallForm,
					priority: Number(firewallForm.priority)
				})
			});
			toast = '防火墙规则已保存';
			resetFirewallForm();
			await loadFirewallRules(firewallVm);
		} catch (err) {
			toast = err instanceof Error ? err.message : '防火墙规则保存失败';
		} finally {
			firewallActionLoading = '';
		}
	}

	async function deleteFirewallRule(rule: FirewallRule) {
		if (!accountId || !firewallVm) return;
		if (!confirm(`确认删除防火墙规则 ${rule.name} 吗？`)) return;
		firewallActionLoading = `delete:${rule.name}`;
		try {
			await api('/api/user/azure/vm/firewall', {
				method: 'DELETE',
				body: JSON.stringify({
					account_id: accountId,
					...proxyPayload(),
					resource_group: firewallVm.resource_group,
					vm_name: firewallVm.name,
					rule_name: rule.name
				})
			});
			toast = '防火墙规则已删除';
			await loadFirewallRules(firewallVm);
		} catch (err) {
			toast = err instanceof Error ? err.message : '防火墙规则删除失败';
		} finally {
			firewallActionLoading = '';
		}
	}

	function badge(state: string) {
		if (state === 'running' || state === 'starting') return 'bg-green-900/50 text-green-300';
		if (state === 'deallocated' || state === 'stopped') return 'bg-red-900/50 text-red-300';
		return 'bg-yellow-900/50 text-yellow-300';
	}

	onMount(async () => {
		refreshAdminPassword();
		refreshCreateNames();
		await loadAccounts();
		if (accountId) {
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
				<input
					id={locationInputId}
					class="input mt-1 min-w-[220px]"
					bind:value={location}
					onchange={() => void changeLocation()}
					placeholder="malaysiawest"
				/>
			</div>
			<button class="btn-primary" onclick={() => void loadVms()} disabled={loading}>刷新 VM</button>
		</div>

		<div class="grid gap-3 md:grid-cols-3">
			<button class="btn-secondary" onclick={() => void loadRegionDetails()} disabled={quotaLoading}>
				{quotaLoading ? '查询中...' : '查询区域配额'}
			</button>
		</div>

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
				<input
					id={createLocationSelectId}
					class="input"
					bind:value={location}
					onchange={() => void changeLocation()}
					placeholder="malaysiawest"
					required
				/>
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
					disabled={sizeLoading || vmSizes.length === 0}
					required
				>
					{#if sizeLoading}
						<option value={createForm.vm_size}>正在从 Azure 官方 API 查询规格...</option>
					{:else if vmSizes.length === 0}
						<option value={createForm.vm_size}>{sizeError || '暂无可选择规格，请先选择账号和区域'}</option>
					{:else}
						{#each vmSizes as size}
							<option value={size.name}>{sizeLabel(size)}</option>
						{/each}
					{/if}
				</select>
				{#if sizeError}
					<p class="mt-1 text-xs text-red-300">{sizeError}</p>
				{/if}
			</div>
		</div>
		<div>
			<label class="mb-1 block text-xs text-muted" for={imageSelectId}>安装系统</label>
			<select
				id={imageSelectId}
				class="input"
				bind:value={createForm.image_reference}
				disabled={imageLoading || vmImages.length === 0}
				required
			>
				{#if imageLoading}
					<option value={createForm.image_reference}>正在从 Azure 官方 API 查询系统镜像...</option>
				{:else if vmImages.length === 0}
					<option value={createForm.image_reference}>{imageError || '暂无可选择系统，请先选择账号和区域'}</option>
				{:else}
					{#each vmImages as image}
						<option value={image.imageReference}>{imageLabel(image)}</option>
					{/each}
				{/if}
			</select>
			{#if imageError}
				<p class="mt-1 text-xs text-red-300">{imageError}</p>
			{/if}
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
		<div>
			<label class="mb-1 block text-xs text-muted" for="create-open-ports">入站放行端口</label>
			<input
				id="create-open-ports"
				class="input"
				bind:value={createForm.open_ports}
				placeholder="* 表示全部端口，也可填写 22,80,443 或 1000-2000"
			/>
			<p class="mt-1 text-xs text-muted">
				创建时会同步创建 Azure 网络安全组（NSG）并绑定到网卡；默认使用 * 放行全部入站端口。
			</p>
		</div>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={createForm.enable_ddos_protection} />
			启用 Azure DDoS 防护计划并关联到虚拟网络
		</label>
		<p class="-mt-2 text-xs text-muted">
			DDoS Protection Plan 可能产生 Azure 官方额外费用，只有勾选后才会创建并在流程里显示进度。
		</p>
		<div class="grid gap-3 md:grid-cols-2">
			<input
				class="input"
				bind:value={createForm.ip_prefix}
				placeholder="目标 IPv4 前缀，留空默认 85.211"
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
			disabled={createLoading}
		>
			{createLoading ? '创建中...' : '创建 VM'}
		</button>
		{#if createProgress.length}
			<div class="rounded-xl border border-border bg-background p-3">
				<div class="mb-3 flex items-center justify-between gap-3">
					<div class="text-sm font-medium">创建流程</div>
					<div class="text-xs text-muted">{createProgress.length} 个步骤</div>
				</div>
				<div class="space-y-2">
					{#each createProgress as item}
						<div class="rounded-lg border border-border/70 p-3">
							<div class="flex flex-wrap items-center gap-2">
								<span class={`badge ${progressBadge(item.status)}`}>{progressText(item.status)}</span>
								<span class="font-mono text-xs text-muted">{item.step}</span>
								<span class="text-sm">{item.message}</span>
							</div>
							{#if progressDetail(item.detail)}
								<div class="mt-1 break-all text-xs text-muted">{progressDetail(item.detail)}</div>
							{/if}
							<div class="mt-1 text-[11px] text-muted">
								{new Date(item.timestamp).toLocaleString()}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
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
							<button
								class="btn-secondary"
								onclick={() => void openFirewall(vm)}
								disabled={firewallLoading && firewallVm?.name === vm.name}
							>
								防火墙
							</button>
						</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>

{#if firewallVm}
	<div class="card mt-4 space-y-4 p-5">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div>
				<h2 class="text-lg font-medium">防火墙策略：{firewallVm.name}</h2>
				<p class="mt-1 text-xs text-muted">
					使用 Azure 官方 Network Security Group API 管理网卡规则。NSG：{firewallNsg || '未绑定，保存规则时自动创建'}（{firewallNsgResourceGroup || '-'}）
				</p>
			</div>
			<div class="flex gap-2">
				<button class="btn-secondary" type="button" onclick={() => void loadFirewallRules()}>
					{firewallLoading ? '刷新中...' : '刷新规则'}
				</button>
				<button class="btn-secondary" type="button" onclick={() => (firewallVm = null)}>
					关闭
				</button>
			</div>
		</div>

		<form class="grid gap-3 lg:grid-cols-4" onsubmit={saveFirewallRule}>
			<input class="input" bind:value={firewallForm.name} placeholder="规则名称，留空自动生成" />
			<select class="input" bind:value={firewallForm.protocol}>
				<option value="Tcp">Tcp</option>
				<option value="Udp">Udp</option>
				<option value="*">*</option>
				<option value="Icmp">Icmp</option>
			</select>
			<input
				class="input"
				bind:value={firewallForm.destination_port_range}
				placeholder="目标端口，如 22 或 1000-2000"
				required
			/>
			<input
				class="input"
				type="number"
				min="100"
				max="4096"
				bind:value={firewallForm.priority}
				placeholder="优先级 100-4096"
				required
			/>
			<input class="input" bind:value={firewallForm.source_address_prefix} placeholder="来源地址，默认 *" />
			<input class="input" bind:value={firewallForm.source_port_range} placeholder="来源端口，默认 *" />
			<select class="input" bind:value={firewallForm.access}>
				<option value="Allow">允许</option>
				<option value="Deny">拒绝</option>
			</select>
			<select class="input" bind:value={firewallForm.direction}>
				<option value="Inbound">入站</option>
				<option value="Outbound">出站</option>
			</select>
			<input
				class="input lg:col-span-3"
				bind:value={firewallForm.description}
				placeholder="说明，可选"
			/>
			<div class="flex gap-2">
				<button class="btn-primary" type="submit" disabled={firewallActionLoading === 'save'}>
					{firewallActionLoading === 'save' ? '保存中...' : '保存规则'}
				</button>
				<button class="btn-secondary" type="button" onclick={resetFirewallForm}>清空</button>
			</div>
		</form>

		<div class="overflow-x-auto rounded-xl border border-border">
			<table class="w-full text-xs">
				<thead class="text-muted">
					<tr class="border-b border-border">
						<th class="p-2 text-left">名称</th>
						<th class="p-2 text-left">方向</th>
						<th class="p-2 text-left">策略</th>
						<th class="p-2 text-left">协议</th>
						<th class="p-2 text-left">来源</th>
						<th class="p-2 text-left">端口</th>
						<th class="p-2 text-left">优先级</th>
						<th class="p-2 text-left">状态</th>
						<th class="p-2 text-left">操作</th>
					</tr>
				</thead>
				<tbody>
					{#if firewallLoading}
						<tr>
							<td class="p-3 text-muted" colspan="9">正在加载防火墙策略...</td>
						</tr>
					{:else if firewallRules.length === 0}
						<tr>
							<td class="p-3 text-muted" colspan="9">暂无自定义防火墙规则</td>
						</tr>
					{:else}
						{#each firewallRules as rule}
							<tr class="border-b border-border/60">
								<td class="p-2 font-mono">{rule.name}</td>
								<td class="p-2">{rule.direction}</td>
								<td class="p-2">{rule.access}</td>
								<td class="p-2">{rule.protocol}</td>
								<td class="p-2">{rule.sourceAddressPrefix}:{rule.sourcePortRange}</td>
								<td class="p-2">{rule.destinationPortRange}</td>
								<td class="p-2">{rule.priority}</td>
								<td class="p-2">{rule.provisioningState || '-'}</td>
								<td class="space-x-2 whitespace-nowrap p-2">
									<button class="btn-secondary" type="button" onclick={() => editFirewallRule(rule)}>
										编辑
									</button>
									<button
										class="btn-danger"
										type="button"
										onclick={() => void deleteFirewallRule(rule)}
										disabled={firewallActionLoading === `delete:${rule.name}`}
									>
										删除
									</button>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</div>
{/if}
