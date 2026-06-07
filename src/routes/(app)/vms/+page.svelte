<script lang="ts">
	import { onMount, tick } from 'svelte';
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
	type DnsBinding = {
		id: number;
		name: string;
		fqdn: string;
		record_type: string;
		enabled: boolean;
		last_ipv4: string;
		last_ipv6: string;
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
	type AzureRegionOption = {
		name: string;
		displayName: string;
		availableSizeCount: number;
		highestCoreSize: { name: string; cores: number } | null;
		largestMemorySize: { name: string; memoryGB: number } | null;
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
	type BrushedIpRecord = {
		key: string;
		attempt: number;
		maxAttempts: number;
		ip: string;
		targetPrefix: string;
		publicIpName: string;
		matched: boolean;
		timestamp: string;
	};
	type OperationStreamMessage<T> =
		| { type: 'progress'; event: CreateProgressEvent }
		| { type: 'result'; result: T }
		| { type: 'error'; message: string };
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
		| { type: 'heartbeat'; timestamp: string }
		| { type: 'error'; message: string };

	let accounts = $state<Account[]>([]);
	let proxies = $state<ProxyProfile[]>([]);
	let dnsBindings = $state<DnsBinding[]>([]);
	let vms = $state<Vm[]>([]);
	let quotas = $state<Quota[]>([]);
	let regions = $state<AzureRegionOption[]>([]);
	let vmSizes = $state<VmSizeOption[]>([]);
	let vmImages = $state<VmImageOption[]>([]);
	let accountId = $state<number | null>(null);
	let resourceGroup = $state('');
	let location = $state('malaysiawest');
	let loading = $state(false);
	let regionLoading = $state(false);
	let quotaLoading = $state(false);
	let sizeLoading = $state(false);
	let imageLoading = $state(false);
	let createLoading = $state(false);
	let ipActionLoading = $state('');
	let firewallLoading = $state(false);
	let firewallActionLoading = $state('');
	let toast = $state('');
	let regionError = $state('');
	let sizeError = $state('');
	let imageError = $state('');
	let createProgress = $state<CreateProgressEvent[]>([]);
	let createBrushedIps = $state<BrushedIpRecord[]>([]);
	let createProgressDialogOpen = $state(false);
	let deleteProgress = $state<CreateProgressEvent[]>([]);
	let deletingVmName = $state('');
	let operationProgress = $state<CreateProgressEvent[]>([]);
	let operationBrushedIps = $state<BrushedIpRecord[]>([]);
	let operationTitle = $state('');
	let operationTarget = $state('');
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
		dns_binding_id: '',
		userdata: '',
		ip_prefix: '',
		ip_brush_max_attempts: 10
	});

	const accountSelectId = 'account-select';
	const proxySelectId = 'vm-proxy-select';
	const proxyProfileSelectId = 'vm-proxy-profile-select';
	const resourceGroupInputId = 'resource-group-input';
	const locationInputId = 'location-input';
	const createLocationSelectId = 'create-location-select';
	const createSizeSelectId = 'create-size-select';
	const imageSelectId = 'image-select';
	const dnsBindingSelectId = 'dns-binding-select';
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

	function clearAccountScopedData() {
		vms = [];
		regions = [];
		quotas = [];
		vmSizes = [];
		vmImages = [];
		regionError = '';
		sizeError = '';
		imageError = '';
		createProgress = [];
		createBrushedIps = [];
		createProgressDialogOpen = false;
		deleteProgress = [];
		operationProgress = [];
		operationBrushedIps = [];
		operationTitle = '';
		operationTarget = '';
		firewallVm = null;
		firewallRules = [];
		firewallNsg = '';
		firewallNsgResourceGroup = '';
		loading = false;
		regionLoading = false;
		quotaLoading = false;
		sizeLoading = false;
		imageLoading = false;
	}

	function progressDetailString(detail: CreateProgressEvent['detail'], key: string) {
		const value = detail?.[key];
		if (value === undefined || value === null || value === '') return '';
		return String(value);
	}

	function progressDetailNumber(detail: CreateProgressEvent['detail'], key: string) {
		const value = Number(detail?.[key] ?? 0);
		return Number.isFinite(value) ? value : 0;
	}

	function brushedIpFromEvent(event: CreateProgressEvent): BrushedIpRecord | null {
		if (event.step !== 'public-ipv4') return null;
		const ip = progressDetailString(event.detail, 'ip');
		const targetPrefix = progressDetailString(event.detail, 'targetPrefix');
		if (!ip || !targetPrefix) return null;

		const attempt = progressDetailNumber(event.detail, 'attempt');
		const maxAttempts = progressDetailNumber(event.detail, 'maxAttempts') || attempt || 1;
		const publicIpName =
			progressDetailString(event.detail, 'publicIpName') ||
			progressDetailString(event.detail, 'name');
		const matched =
			event.detail?.matched === true || (event.status === 'success' && ip.startsWith(targetPrefix));
		return {
			key: `${targetPrefix}:${attempt}:${ip}:${publicIpName || '-'}`,
			attempt,
			maxAttempts,
			ip,
			targetPrefix,
			publicIpName,
			matched,
			timestamp: event.timestamp
		};
	}

	function upsertBrushedIp(records: BrushedIpRecord[], record: BrushedIpRecord) {
		const index = records.findIndex((item) => item.key === record.key);
		if (index === -1) return [...records, record];
		return records.map((item, itemIndex) => (itemIndex === index ? { ...item, ...record } : item));
	}

	function rememberCreateBrushedIp(event: CreateProgressEvent) {
		const record = brushedIpFromEvent(event);
		if (!record) return;
		createBrushedIps = upsertBrushedIp(createBrushedIps, record);
	}

	function rememberOperationBrushedIp(event: CreateProgressEvent) {
		const record = brushedIpFromEvent(event);
		if (!record) return;
		operationBrushedIps = upsertBrushedIp(operationBrushedIps, record);
	}

	function mergeCreateProgress(event: CreateProgressEvent) {
		rememberCreateBrushedIp(event);
		const index = createProgress.findIndex((item) => item.step === event.step);
		if (index === -1) {
			createProgress = [...createProgress, event];
			return;
		}
		createProgress = createProgress.map((item, itemIndex) =>
			itemIndex === index ? { ...item, ...event } : item
		);
	}

	function beginCreateProgressDialog() {
		createBrushedIps = [];
		createProgress = [
			{
				step: 'prepare',
				status: 'running',
				message: '正在准备创建 VM 请求，页面会持续显示实时进度',
				detail: {
					resource_group: createForm.resource_group,
					vm_name: createForm.vm_name,
					location: createForm.location,
					size: createForm.vm_size
				},
				timestamp: new Date().toISOString()
			}
		];
		createProgressDialogOpen = true;
	}

	async function waitForCreateProgressFirstPaint() {
		await tick();
		if (typeof requestAnimationFrame !== 'function') {
			await new Promise((resolve) => setTimeout(resolve, 0));
			return;
		}
		await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
		await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
	}

	function closeCreateProgressDialog() {
		if (createLoading) return;
		createProgressDialogOpen = false;
	}

	function mergeDeleteProgress(event: CreateProgressEvent) {
		const index = deleteProgress.findIndex((item) => item.step === event.step);
		if (index === -1) {
			deleteProgress = [...deleteProgress, event];
			return;
		}
		deleteProgress = deleteProgress.map((item, itemIndex) =>
			itemIndex === index ? { ...item, ...event } : item
		);
	}

	function mergeOperationProgress(event: CreateProgressEvent) {
		rememberOperationBrushedIp(event);
		const index = operationProgress.findIndex((item) => item.step === event.step);
		if (index === -1) {
			operationProgress = [...operationProgress, event];
			return;
		}
		operationProgress = operationProgress.map((item, itemIndex) =>
			itemIndex === index ? { ...item, ...event } : item
		);
	}

	function progressPercent(progress: CreateProgressEvent[]) {
		if (progress.length === 0) return 0;
		if (progress.some((item) => item.status === 'error')) return 100;
		if (progress.some((item) => item.step.endsWith('complete') && item.status === 'success')) return 100;
		if (progress.some((item) => item.step === 'operation-complete' && item.status === 'success')) return 100;
		if (progress.length > 0 && progress.every((item) => item.status !== 'running')) return 100;
		const complete = progress.filter((item) => item.status === 'success' || item.status === 'info').length;
		return Math.min(95, Math.max(8, Math.round((complete / Math.max(progress.length, 1)) * 100)));
	}

	function progressFinished(progress: CreateProgressEvent[]) {
		return (
			progress.some((item) => item.status === 'error') ||
			progress.some((item) => item.step.endsWith('complete') && item.status === 'success') ||
			progress.some((item) => item.step === 'operation-complete' && item.status === 'success') ||
			(progress.length > 0 && progress.every((item) => item.status !== 'running'))
		);
	}

	function progressTone(progress: CreateProgressEvent[]) {
		if (progress.some((item) => item.status === 'error')) return 'bg-red-500';
		if (progressFinished(progress)) return 'bg-green-500';
		return 'bg-primary';
	}

	function progressAnimation(progress: CreateProgressEvent[]) {
		return !progressFinished(progress) && progress.some((item) => item.status === 'running') ? 'running' : '';
	}

	function beginOperationProgress(title: string, target: string) {
		operationTitle = title;
		operationTarget = target;
		operationBrushedIps = [];
		operationProgress = [
			{
				step: 'request',
				status: 'running',
				message: '正在提交操作请求',
				timestamp: new Date().toISOString()
			}
		];
	}

	function failOperationProgress(message: string) {
		mergeOperationProgress({
			step: 'operation-failed',
			status: 'error',
			message,
			timestamp: new Date().toISOString()
		});
	}

	function vmActionBusy(vmName: string) {
		return ipActionLoading.startsWith(`${vmName}:`);
	}

	async function requestOperationWithProgress<T>(
		path: string,
		options: { method?: string; body?: Record<string, unknown> } = {}
	) {
		const token = localStorage.getItem('token');
		const response = await fetch(path, {
			method: options.method ?? 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/x-ndjson',
				...(token ? { Authorization: `Bearer ${token}` } : {})
			},
			...(options.body ? { body: JSON.stringify(options.body) } : {})
		});
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			throw new Error(body?.message ?? `操作请求失败 (${response.status})`);
		}
		if (!response.body) throw new Error('浏览器不支持读取操作进度流');
		mergeOperationProgress({
			step: 'request',
			status: 'success',
			message: '操作请求已提交，正在等待 Azure 返回进度',
			timestamp: new Date().toISOString()
		});

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let result: T | null = null;

		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				const message = JSON.parse(line) as OperationStreamMessage<T>;
				if (message.type === 'progress') {
					mergeOperationProgress(message.event);
				} else if (message.type === 'result') {
					result = message.result;
				} else if (message.type === 'error') {
					throw new Error(message.message);
				}
			}
			if (done) break;
		}
		if (!result) throw new Error('操作流程结束但未返回结果');
		mergeOperationProgress({
			step: 'operation-complete',
			status: 'success',
			message: '操作流程已完成',
			timestamp: new Date().toISOString()
		});
		return result;
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

	function regionLabel(region: AzureRegionOption) {
		const parts = [`${region.displayName || region.name} (${region.name})`];
		if (region.availableSizeCount > 0) {
			parts.push(`${region.availableSizeCount} 个可用规格`);
		}
		if (region.highestCoreSize) {
			parts.push(`最高 ${region.highestCoreSize.name}/${region.highestCoreSize.cores}C`);
		}
		if (region.largestMemorySize) {
			parts.push(`最大内存 ${region.largestMemorySize.name}/${region.largestMemorySize.memoryGB}GB`);
		}
		return parts.join('，');
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
				} else if (message.type === 'heartbeat') {
					continue;
				} else if (message.type === 'error') {
					throw new Error(message.message);
				}
			}
			if (done) break;
		}
		if (!result) throw new Error('创建流程结束但未返回 VM 结果');
		return result;
	}

	async function deleteResourceGroupWithProgress(payload: Record<string, unknown>) {
		const token = localStorage.getItem('token');
		const response = await fetch('/api/user/azure/vm/delete', {
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
			throw new Error(body?.message ?? `删除请求失败 (${response.status})`);
		}
		if (!response.body) throw new Error('浏览器不支持读取删除进度流');

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let result: { message: string } | null = null;

		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				const message = JSON.parse(line) as
					| { type: 'progress'; event: CreateProgressEvent }
					| { type: 'result'; result: { message: string } }
					| { type: 'error'; message: string };
				if (message.type === 'progress') {
					mergeDeleteProgress(message.event);
				} else if (message.type === 'result') {
					result = message.result;
				} else if (message.type === 'error') {
					throw new Error(message.message);
				}
			}
			if (done) break;
		}
		if (!result) throw new Error('删除流程结束但未返回结果');
		return result;
	}

	async function changeProxySelection() {
		syncProxySelection();
		if (accountId) {
			await Promise.all([loadVms(), loadRegions()]);
		}
	}

	async function loadAccounts() {
		const [accountList, proxyList, bindingList] = await Promise.all([
			api<Account[]>('/api/user/azure/account/list'),
			api<ProxyProfile[]>('/api/user/proxy/list'),
			api<DnsBinding[]>('/api/user/dns/binding/list')
		]);
		accounts = accountList;
		proxies = proxyList;
		dnsBindings = bindingList.filter((binding) => binding.enabled);
		syncProxySelection();
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

	async function loadRegions(refresh = false) {
		if (!accountId) {
			regions = [];
			regionError = '';
			return;
		}
		regionLoading = true;
		regionError = '';
		try {
			const params = new URLSearchParams({ account_id: String(accountId) });
			if (refresh) params.set('refresh', '1');
			appendProxyParams(params);
			regions = await api<AzureRegionOption[]>(`/api/user/azure/region/list?${params}`);
			if (regions.length && !regions.some((region) => region.name === location)) {
				location = regions[0].name;
			}
			syncCreateLocation();
			await loadRegionDetails(refresh);
		} catch (err) {
			regions = [];
			regionError = err instanceof Error ? err.message : '区域识别失败';
			toast = regionError;
			quotas = [];
			vmSizes = [];
			vmImages = [];
		} finally {
			regionLoading = false;
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

	async function loadVmImages(requestId: number, refresh = false) {
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
			if (refresh) params.set('refresh', '1');
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

	async function loadCreateOptions(refreshImages = false) {
		syncCreateLocation();
		const requestId = ++createOptionsRequestId;
		await Promise.all([loadVmSizes(requestId), loadVmImages(requestId, refreshImages)]);
	}

	async function loadRegionDetails(refreshImages = false) {
		syncCreateLocation();
		quotas = [];
		await Promise.all([loadQuotas(), loadCreateOptions(refreshImages)]);
	}

	async function changeAccount() {
		refreshAdminPassword();
		refreshCreateNames();
		syncProxySelection();
		if (!accountId) {
			clearAccountScopedData();
			return;
		}
		await Promise.all([loadVms(), loadRegions()]);
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
		if (!regions.some((region) => region.name === createForm.location)) {
			toast = '请先从 Azure 官方 API 返回的可开机区域下拉列表中选择区域';
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
		refreshCreateNames();
		createLoading = true;
		beginCreateProgressDialog();
		await waitForCreateProgressFirstPaint();
		try {
			const result = await createVmWithProgress({
				...createForm,
				account_id: accountId,
				...proxyPayload(),
				dns_binding_id: createForm.dns_binding_id ? Number(createForm.dns_binding_id) : 0,
				ip_brush_max_attempts: Number(createForm.ip_brush_max_attempts)
			});
			mergeCreateProgress({
				step: 'prepare',
				status: 'success',
				message: '创建请求已完成',
				timestamp: new Date().toISOString()
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
		const actionLabels = {
			on: '开机',
			off: '关机',
			restart: '重启'
		};
		ipActionLoading = `${vm.name}:power:${action}`;
		beginOperationProgress(`VM ${actionLabels[action]}`, vm.name);
		try {
			const result = await requestOperationWithProgress<{ message: string }>(
				`/api/user/azure/vm/power/${action}`,
				{
					method: 'POST',
					body: {
						account_id: accountId,
						...proxyPayload(),
						resource_group: vm.resource_group,
						vm_name: vm.name
					}
				}
			);
			toast = result.message || `${vm.name} ${actionLabels[action]}完成`;
			await loadVms();
		} catch (err) {
			const message = err instanceof Error ? err.message : '操作失败';
			failOperationProgress(message);
			toast = message;
		} finally {
			ipActionLoading = '';
		}
	}

	async function deleteVmResourceGroup(vm: Vm) {
		if (!accountId) return;
		const confirmed = confirm(
			`危险操作：将完整删除资源组 ${vm.resource_group}，包括 VM ${vm.name} 以及该资源组内全部资源。确认继续吗？`
		);
		if (!confirmed) return;
		ipActionLoading = `${vm.name}:delete`;
		deletingVmName = vm.name;
		deleteProgress = [
			{
				step: 'delete-request',
				status: 'running',
				message: '已确认删除，正在提交资源组删除请求',
				detail: {
					resourceGroup: vm.resource_group,
					vmName: vm.name
				},
				timestamp: new Date().toISOString()
			}
		];
		try {
			const result = await deleteResourceGroupWithProgress({
				account_id: accountId,
				...proxyPayload(),
				resource_group: vm.resource_group,
				vm_name: vm.name
			});
			toast = result.message;
			resourceGroup = resourceGroup === vm.resource_group ? '' : resourceGroup;
			await loadVms();
		} catch (err) {
			const message = err instanceof Error ? err.message : '删除资源组失败';
			mergeDeleteProgress({
				step: 'delete-failed',
				status: 'error',
				message,
				timestamp: new Date().toISOString()
			});
			toast = message;
		} finally {
			ipActionLoading = '';
		}
	}

	async function replaceIp(vm: Vm) {
		if (!accountId) return;
		if (!confirm(`确认给 ${vm.name} 更换公网 IPv4 吗？此操作可能造成短暂网络中断。`)) return;
		ipActionLoading = `${vm.name}:replace`;
		beginOperationProgress('更换公网 IPv4', vm.name);
		try {
			const result = await requestOperationWithProgress<{ public_ipv4: string; old_public_ipv4: string }>(
				'/api/user/azure/vm/ip/replace',
				{
					method: 'POST',
					body: {
						account_id: accountId,
						...proxyPayload(),
						resource_group: vm.resource_group,
						vm_name: vm.name
					}
				}
			);
			toast = `${vm.name} 已更换 IPv4：${result.old_public_ipv4 || '-'} -> ${result.public_ipv4 || '-'}`;
			await loadVms();
		} catch (err) {
			const message = err instanceof Error ? err.message : '换 IP 失败';
			failOperationProgress(message);
			toast = message;
		} finally {
			ipActionLoading = '';
		}
	}

	async function refreshVmIps(vm: Vm) {
		if (!accountId) return;
		ipActionLoading = `${vm.name}:refresh-ip`;
		beginOperationProgress('重读网卡 IP 配置', vm.name);
		try {
			const result = await requestOperationWithProgress<{
				public_ipv4: string;
				public_ipv6: string;
				nic_name: string;
			}>('/api/user/azure/vm/ip/refresh', {
				method: 'POST',
				body: {
					account_id: accountId,
					...proxyPayload(),
					resource_group: vm.resource_group,
					vm_name: vm.name
				}
			});
			vms = vms.map((item) =>
				item.name === vm.name && item.resource_group === vm.resource_group
					? {
							...item,
							public_ipv4: result.public_ipv4 || '',
							public_ipv6: result.public_ipv6 || ''
						}
					: item
			);
			toast = `${vm.name} 已重读网卡 ${result.nic_name || '-'}，IPv4=${result.public_ipv4 || '-'} IPv6=${result.public_ipv6 || '-'}`;
			await loadVms();
		} catch (err) {
			const message = err instanceof Error ? err.message : '重读 IP 失败';
			failOperationProgress(message);
			toast = message;
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
		beginOperationProgress(`刷 IPv4 段 ${brushIpPrefix}`, vm.name);
		try {
			const result = await requestOperationWithProgress<{ public_ipv4: string; attempts: number }>(
				'/api/user/azure/vm/ip/brush',
				{
					method: 'POST',
					body: {
						account_id: accountId,
						...proxyPayload(),
						resource_group: vm.resource_group,
						vm_name: vm.name,
						ip_prefix: brushIpPrefix,
						max_attempts: Number(brushMaxAttempts)
					}
				}
			);
			toast = `${vm.name} 已匹配 IPv4 ${result.public_ipv4}，尝试 ${result.attempts} 次`;
			await loadVms();
		} catch (err) {
			const message = err instanceof Error ? err.message : '刷 IP 失败';
			failOperationProgress(message);
			toast = message;
		} finally {
			ipActionLoading = '';
		}
	}

	async function enableDdos(vm: Vm) {
		if (!accountId) return;
		const ok = confirm(
			`确认为 ${vm.name} 单独开启 Azure DDoS 防护计划吗？DDoS Protection Plan 可能产生 Azure 官方额外费用。`
		);
		if (!ok) return;
		ipActionLoading = `${vm.name}:ddos`;
		beginOperationProgress('开启 DDoS 防护计划', vm.name);
		try {
			const result = await requestOperationWithProgress<{
				message: string;
				ddos_protection_plan_name: string;
				virtual_network_name: string;
				public_ipv4: string;
			}>('/api/user/azure/vm/ddos', {
				method: 'POST',
				body: {
					account_id: accountId,
					...proxyPayload(),
					resource_group: vm.resource_group,
					vm_name: vm.name
				}
			});
			toast = `${result.message}，VNet=${result.virtual_network_name || '-'}，Plan=${result.ddos_protection_plan_name || '-'}`;
			await loadVms();
		} catch (err) {
			const message = err instanceof Error ? err.message : 'DDoS 防护开启失败';
			failOperationProgress(message);
			toast = message;
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

	async function loadFirewallRules(vm = firewallVm, options: { showProgress?: boolean } = {}) {
		if (!accountId || !vm) return;
		firewallLoading = true;
		const showProgress = options.showProgress ?? true;
		if (showProgress) beginOperationProgress('加载防火墙策略', vm.name);
		try {
			const params = new URLSearchParams({
				account_id: String(accountId),
				resource_group: vm.resource_group,
				vm_name: vm.name
			});
			appendProxyParams(params);
			const result = showProgress
				? await requestOperationWithProgress<FirewallRuleResponse>(
						`/api/user/azure/vm/firewall?${params}`,
						{
							method: 'GET'
						}
					)
				: await api<FirewallRuleResponse>(`/api/user/azure/vm/firewall?${params}`);
			firewallVm = vm;
			firewallRules = result.rules ?? [];
			firewallNsg = result.networkSecurityGroup;
			firewallNsgResourceGroup = result.networkSecurityGroupResourceGroup;
			toast = `已加载 ${vm.name} 防火墙策略`;
		} catch (err) {
			const message = err instanceof Error ? err.message : '防火墙策略加载失败';
			if (showProgress) failOperationProgress(message);
			toast = message;
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
		beginOperationProgress('保存防火墙规则', firewallVm.name);
		try {
			await requestOperationWithProgress<FirewallRule>('/api/user/azure/vm/firewall', {
				method: 'POST',
				body: {
					account_id: accountId,
					...proxyPayload(),
					resource_group: firewallVm.resource_group,
					vm_name: firewallVm.name,
					...firewallForm,
					priority: Number(firewallForm.priority)
				}
			});
			toast = '防火墙规则已保存';
			resetFirewallForm();
			await loadFirewallRules(firewallVm, { showProgress: false });
		} catch (err) {
			const message = err instanceof Error ? err.message : '防火墙规则保存失败';
			failOperationProgress(message);
			toast = message;
		} finally {
			firewallActionLoading = '';
		}
	}

	async function deleteFirewallRule(rule: FirewallRule) {
		if (!accountId || !firewallVm) return;
		if (!confirm(`确认删除防火墙规则 ${rule.name} 吗？`)) return;
		firewallActionLoading = `delete:${rule.name}`;
		beginOperationProgress(`删除防火墙规则 ${rule.name}`, firewallVm.name);
		try {
			await requestOperationWithProgress<{ networkSecurityGroup: string; ruleName: string }>(
				'/api/user/azure/vm/firewall',
				{
				method: 'DELETE',
					body: {
					account_id: accountId,
					...proxyPayload(),
					resource_group: firewallVm.resource_group,
					vm_name: firewallVm.name,
					rule_name: rule.name
					}
				}
			);
			toast = '防火墙规则已删除';
			await loadFirewallRules(firewallVm, { showProgress: false });
		} catch (err) {
			const message = err instanceof Error ? err.message : '防火墙规则删除失败';
			failOperationProgress(message);
			toast = message;
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
					value={accountId ?? ''}
					onchange={(event) => {
						const value = (event.currentTarget as HTMLSelectElement).value;
						accountId = value ? Number(value) : null;
						void changeAccount();
					}}
				>
					<option value="">请选择 Azure 账号</option>
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
					disabled={regionLoading || regions.length === 0}
				>
					{#if regionLoading}
						<option value={location}>正在识别当前账号可开机区域...</option>
					{:else if regions.length === 0}
						<option value={location}>{regionError || '暂无可选区域，请先选择账号'}</option>
					{:else}
						{#each regions as region}
							<option value={region.name}>{regionLabel(region)}</option>
						{/each}
					{/if}
				</select>
				{#if regionError}
					<p class="mt-1 max-w-sm text-xs text-red-300">{regionError}</p>
				{/if}
			</div>
			<button class="btn-primary" onclick={() => void loadVms()} disabled={loading}>刷新 VM</button>
		</div>

		<div class="grid gap-3 md:grid-cols-3">
			<button
				class="btn-secondary"
				onclick={() => void loadRegionDetails()}
				disabled={regionLoading || quotaLoading || !location || regions.length === 0}
			>
				{quotaLoading ? '查询中...' : '查询当前区域配额'}
			</button>
			<button class="btn-secondary" onclick={() => void loadRegions(true)} disabled={!accountId || regionLoading}>
				{regionLoading ? '识别区域中...' : '重新识别可开机区域'}
			</button>
			<p class="self-center text-xs text-muted">
				区域列表来自 Azure 官方 API 返回的当前账号可创建 VM 区域。
			</p>
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
				<select
					id={createLocationSelectId}
					class="input"
					bind:value={location}
					onchange={() => void changeLocation()}
					disabled={regionLoading || regions.length === 0}
					required
				>
					{#if regionLoading}
						<option value={location}>正在识别当前账号可开机区域...</option>
					{:else if regions.length === 0}
						<option value={location}>{regionError || '暂无可选区域，请先选择账号'}</option>
					{:else}
						{#each regions as region}
							<option value={region.name}>{regionLabel(region)}</option>
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
		<div>
			<label class="mb-1 block text-xs text-muted" for={dnsBindingSelectId}>开机后自动 DNS 解析</label>
			<select id={dnsBindingSelectId} class="input" bind:value={createForm.dns_binding_id}>
				<option value="">不自动解析</option>
				{#each dnsBindings as binding}
					<option value={String(binding.id)}>
						{binding.name} - {binding.fqdn} ({binding.record_type})
					</option>
				{/each}
			</select>
			<p class="mt-1 text-xs text-muted">
				可在 DNS 管理页面连接彩虹 DNS 面板并创建绑定；选择后，VM 创建成功会把公网 IP 自动同步到对应 A / AAAA 记录。
			</p>
		</div>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={createForm.enable_ddos_protection} />
			启用 Azure DDoS 防护计划并关联到虚拟网络
		</label>
		<p class="-mt-2 text-xs text-muted">
			DDoS Protection Plan 可能产生 Azure 官方额外费用；如果当前订阅或区域不允许创建，将自动跳过并继续创建 VM。
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
		<p class="-mt-2 text-xs text-muted">
			创建 VM 时默认最多刷 10 次 IPv4；超过最大次数仍未命中，会保留最后一次刷到的 IPv4 并继续下一步。
		</p>
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
		{#if createProgress.length && !createProgressDialogOpen}
			<div class="rounded-xl border border-border bg-background p-3">
				<div class="mb-3 flex items-center justify-between gap-3">
					<div class="text-sm font-medium">创建流程</div>
					<div class="text-xs text-muted">{createProgress.length} 个步骤</div>
				</div>
				<div class={`progress-track mb-3 ${progressAnimation(createProgress)}`}>
					<div
						class={`progress-fill ${progressTone(createProgress)}`}
						style={`width: ${progressPercent(createProgress)}%`}
					></div>
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

{#if createProgressDialogOpen}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-labelledby="create-progress-title"
	>
		<div class="w-full max-w-2xl overflow-hidden rounded-2xl border border-primary/40 bg-card shadow-2xl shadow-primary/20">
			<div class="relative overflow-hidden border-b border-border bg-gradient-to-r from-primary/20 via-blue-500/10 to-cyan-400/10 p-5">
				<div class="progress-dialog-orb"></div>
				<div class="relative flex flex-wrap items-start justify-between gap-3">
					<div>
						<div class="text-xs font-medium uppercase tracking-[0.28em] text-primary">
							Azure VM Progress
						</div>
						<h2 id="create-progress-title" class="mt-2 text-xl font-semibold">
							{createLoading ? '正在创建 VM' : '创建 VM 流程已结束'}
						</h2>
						<p class="mt-1 text-sm text-muted">
							{createLoading
								? '请保持当前页面打开，窗口会实时刷新 Azure 官方 API 返回的创建步骤。'
								: '可以查看最后的创建结果和每一步状态。'}
						</p>
					</div>
					<button
						class="btn-secondary"
						type="button"
						onclick={closeCreateProgressDialog}
						disabled={createLoading}
					>
						{createLoading ? '创建中...' : '关闭窗口'}
					</button>
				</div>
				<div class={`progress-track mt-5 h-3 ${progressAnimation(createProgress) || (createLoading ? 'running' : '')}`}>
					<div
						class={`progress-fill ${progressTone(createProgress)}`}
						style={`width: ${progressPercent(createProgress)}%`}
					></div>
				</div>
				<div class="relative mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
					<span>进度：{progressPercent(createProgress)}%</span>
					<span>{createProgress.length} 个步骤</span>
				</div>
			</div>

			<div class="space-y-4 p-5">
				<div class="grid gap-3 text-sm sm:grid-cols-2">
					<div class="rounded-xl border border-border bg-background/80 p-3">
						<div class="text-xs text-muted">资源组</div>
						<div class="mt-1 break-all font-mono">{createForm.resource_group || '-'}</div>
					</div>
					<div class="rounded-xl border border-border bg-background/80 p-3">
						<div class="text-xs text-muted">VM 名称</div>
						<div class="mt-1 break-all font-mono">{createForm.vm_name || '-'}</div>
					</div>
					<div class="rounded-xl border border-border bg-background/80 p-3">
						<div class="text-xs text-muted">区域</div>
						<div class="mt-1 font-mono">{createForm.location || '-'}</div>
					</div>
					<div class="rounded-xl border border-border bg-background/80 p-3">
						<div class="text-xs text-muted">规格</div>
						<div class="mt-1 font-mono">{createForm.vm_size || '-'}</div>
					</div>
				</div>

				{#if createBrushedIps.length}
					<div class="rounded-xl border border-blue-500/30 bg-blue-950/20 p-4">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<div>
								<div class="text-sm font-medium text-blue-100">已刷到 IPv4</div>
								<div class="mt-1 text-xs text-muted">
									目标前缀 {createBrushedIps[0]?.targetPrefix}，已记录 {createBrushedIps.length} 个公网 IP
								</div>
							</div>
							<div class="badge bg-blue-900/50 text-blue-200">
								{createBrushedIps.some((item) => item.matched) ? '已命中' : '刷段中'}
							</div>
						</div>
						<div class="mt-3 max-h-36 space-y-2 overflow-y-auto pr-1">
							{#each createBrushedIps as item}
								<div class="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-xs">
									<span class={`badge ${item.matched ? 'bg-green-900/50 text-green-300' : 'bg-slate-800 text-slate-300'}`}>
										{item.matched ? '命中' : '未命中'}
									</span>
									<span class="font-mono text-muted">#{item.attempt}/{item.maxAttempts}</span>
									<span class="font-mono text-blue-100">{item.ip}</span>
									{#if item.publicIpName}
										<span class="break-all text-muted">{item.publicIpName}</span>
									{/if}
									<span class="ml-auto text-[11px] text-muted">{new Date(item.timestamp).toLocaleTimeString()}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<div class="max-h-80 space-y-2 overflow-y-auto pr-1">
					{#each createProgress as item}
						<div class="rounded-xl border border-border/70 bg-background/70 p-3">
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
		</div>
	</div>
{/if}

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

{#if deleteProgress.length}
	<div class="card mb-4 space-y-3 p-5">
		<div class="flex items-center justify-between gap-3">
			<div>
				<h2 class="text-lg font-medium">删除流程{deletingVmName ? `：${deletingVmName}` : ''}</h2>
				<p class="mt-1 text-xs text-muted">
					删除 VM 会通过 Azure 官方 API 删除完整资源组，耗时取决于资源组内资源数量。
				</p>
			</div>
			<div class="text-xs text-muted">{deleteProgress.length} 个步骤</div>
		</div>
		<div class={`progress-track ${progressAnimation(deleteProgress)}`}>
			<div
				class={`progress-fill ${progressTone(deleteProgress)}`}
				style={`width: ${progressPercent(deleteProgress)}%`}
			></div>
		</div>
		<div class="space-y-2">
			{#each deleteProgress as item}
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

{#if operationProgress.length}
	<div class="card mb-4 space-y-3 p-5">
		<div class="flex items-center justify-between gap-3">
			<div>
				<h2 class="text-lg font-medium">
					{operationTitle || 'VM 操作进度'}{operationTarget ? `：${operationTarget}` : ''}
				</h2>
				<p class="mt-1 text-xs text-muted">
					这些操作通过 Azure 官方 API 实时轮询，页面会持续显示提交、执行、轮询和完成状态。
				</p>
			</div>
			<div class="text-xs text-muted">{operationProgress.length} 个步骤</div>
		</div>
		<div class={`progress-track ${progressAnimation(operationProgress)}`}>
			<div
				class={`progress-fill ${progressTone(operationProgress)}`}
				style={`width: ${progressPercent(operationProgress)}%`}
			></div>
		</div>
		{#if operationBrushedIps.length}
			<div class="rounded-xl border border-blue-500/30 bg-blue-950/20 p-4">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div>
						<div class="text-sm font-medium text-blue-100">已刷到 IPv4</div>
						<div class="mt-1 text-xs text-muted">
							目标前缀 {operationBrushedIps[0]?.targetPrefix}，已记录 {operationBrushedIps.length} 个公网 IP
						</div>
					</div>
					<div class="badge bg-blue-900/50 text-blue-200">
						{operationBrushedIps.some((item) => item.matched) ? '已命中' : '刷段中'}
					</div>
				</div>
				<div class="mt-3 max-h-36 space-y-2 overflow-y-auto pr-1">
					{#each operationBrushedIps as item}
						<div class="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-xs">
							<span class={`badge ${item.matched ? 'bg-green-900/50 text-green-300' : 'bg-slate-800 text-slate-300'}`}>
								{item.matched ? '命中' : '未命中'}
							</span>
							<span class="font-mono text-muted">#{item.attempt}/{item.maxAttempts}</span>
							<span class="font-mono text-blue-100">{item.ip}</span>
							{#if item.publicIpName}
								<span class="break-all text-muted">{item.publicIpName}</span>
							{/if}
							<span class="ml-auto text-[11px] text-muted">{new Date(item.timestamp).toLocaleTimeString()}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
		<div class="space-y-2">
			{#each operationProgress as item}
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
							<button
								class="btn-primary"
								onclick={() => void power('on', vm)}
								disabled={vmActionBusy(vm.name)}
							>
								{ipActionLoading === `${vm.name}:power:on` ? '开机中...' : '开机'}
							</button>
							<button
								class="btn-secondary"
								onclick={() => void power('off', vm)}
								disabled={vmActionBusy(vm.name)}
							>
								{ipActionLoading === `${vm.name}:power:off` ? '关机中...' : '关机'}
							</button>
							<button
								class="btn-secondary"
								onclick={() => void power('restart', vm)}
								disabled={vmActionBusy(vm.name)}
							>
								{ipActionLoading === `${vm.name}:power:restart` ? '重启中...' : '重启'}
							</button>
							<button
								class="btn-secondary"
								onclick={() => void replaceIp(vm)}
								disabled={vmActionBusy(vm.name)}
							>
								{ipActionLoading === `${vm.name}:replace` ? '更换中...' : '换 IPv4'}
							</button>
							<button
								class="btn-secondary"
								onclick={() => void refreshVmIps(vm)}
								disabled={vmActionBusy(vm.name)}
							>
								{ipActionLoading === `${vm.name}:refresh-ip` ? '重读中...' : '重读 IP'}
							</button>
							<button
								class="btn-secondary"
								onclick={() => void brushIp(vm)}
								disabled={vmActionBusy(vm.name)}
							>
								{ipActionLoading === `${vm.name}:brush` ? '刷 IP 中...' : '刷 IPv4 段'}
							</button>
							<button
								class="btn-secondary"
								onclick={() => void openFirewall(vm)}
								disabled={firewallLoading && firewallVm?.name === vm.name}
							>
								{firewallLoading && firewallVm?.name === vm.name ? '加载中...' : '防火墙'}
							</button>
							<button
								class="btn-secondary"
								onclick={() => void enableDdos(vm)}
								disabled={vmActionBusy(vm.name)}
							>
								{ipActionLoading === `${vm.name}:ddos` ? '开启中...' : 'DDoS'}
							</button>
							<button
								class="btn-danger"
								onclick={() => void deleteVmResourceGroup(vm)}
								disabled={vmActionBusy(vm.name)}
							>
								{ipActionLoading === `${vm.name}:delete` ? '删除中...' : '删除资源组'}
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
