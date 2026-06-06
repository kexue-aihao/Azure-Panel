<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Account = { id: number; name: string };
	type DnsBinding = { id: number; name: string; fqdn: string; enabled: boolean };
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
		quota_localized_name: string;
		quota_remaining: number;
		quota_required: number;
	};
	type VmImageOption = {
		label: string;
		imageReference: string;
		osType: 'Linux' | 'Windows' | 'Unknown';
		architecture: string;
		hyperVGeneration: string;
	};
	type AccountStatus = {
		state: string;
		abnormal: boolean;
		should_run_workflow: boolean;
		subscription_id: string;
		display_name: string;
		checked_at: string;
	};
	type Workflow = {
		id: number;
		name: string;
		enabled: boolean;
		resource_group: string;
		min_running_count: number;
		replenish_target_count: number;
		auto_start: boolean;
		auto_create: boolean;
		enable_ipv6: boolean;
		ip_prefix: string;
		ip_brush_max_attempts: number;
		userdata_configured: boolean;
		check_interval_seconds: number;
		status_check_enabled: boolean;
		status_trigger_states: string;
		dns_binding_id: number;
		last_account_status: string;
		last_status_checked_at: string | null;
	};

	let accounts = $state<Account[]>([]);
	let dnsBindings = $state<DnsBinding[]>([]);
	let regions = $state<AzureRegionOption[]>([]);
	let vmSizes = $state<VmSizeOption[]>([]);
	let vmImages = $state<VmImageOption[]>([]);
	let workflows = $state<Workflow[]>([]);
	let form = $state({
		account_id: '',
		name: '',
		resource_group: '',
		location: 'eastus',
		vm_names: '',
		min_running_count: 1,
		replenish_target_count: 1,
		auto_start: true,
		auto_create: false,
		vm_size: 'Standard_B1s',
		image_reference: 'Canonical:ubuntu-24_04-lts:server:latest',
		name_prefix: 'auto-vm',
		admin_username: 'azureuser',
		admin_password: '',
		userdata: '',
		enable_ipv6: true,
		ip_prefix: '',
		ip_brush_max_attempts: 30,
		check_interval_seconds: '',
		status_check_enabled: true,
		status_trigger_states: 'banned,warning,warned',
		dns_binding_id: ''
	});
	let toast = $state('');
	let checkingStatus = $state(false);
	let statusResult = $state<AccountStatus | null>(null);
	let regionLoading = $state(false);
	let sizeLoading = $state(false);
	let imageLoading = $state(false);
	let regionError = $state('');
	let sizeError = $state('');
	let imageError = $state('');
	let createOptionsRequestId = 0;

	function regionLabel(region: AzureRegionOption) {
		const parts = [`${region.displayName || region.name} (${region.name})`];
		if (region.availableSizeCount > 0) parts.push(`${region.availableSizeCount} 个可用规格`);
		if (region.highestCoreSize) {
			parts.push(`最高 ${region.highestCoreSize.name}/${region.highestCoreSize.cores}C`);
		}
		if (region.largestMemorySize) {
			parts.push(`最大内存 ${region.largestMemorySize.name}/${region.largestMemorySize.memoryGB}GB`);
		}
		return parts.join('，');
	}

	function sizeLabel(size: VmSizeOption) {
		const memory = Number.isFinite(size.memory_gb) ? `${size.memory_gb} GB` : '-';
		const quota =
			size.quota_remaining || size.quota_required
				? `，剩余 ${size.quota_remaining}/${size.quota_required} vCPU`
				: '';
		return `${size.name}，${size.cores}C / ${memory}${quota}`;
	}

	function imageLabel(image: VmImageOption) {
		const meta = [image.osType, image.architecture, image.hyperVGeneration]
			.filter(Boolean)
			.join(' / ');
		return meta ? `${image.label} - ${meta}` : image.label;
	}

	function clearCreateOptions() {
		regions = [];
		vmSizes = [];
		vmImages = [];
		regionError = '';
		sizeError = '';
		imageError = '';
	}

	async function load() {
		accounts = await api<Account[]>('/api/user/azure/account/list');
		dnsBindings = await api<DnsBinding[]>('/api/user/dns/binding/list');
		workflows = await api<Workflow[]>('/api/user/workflow/list');
	}

	async function loadRegions() {
		if (!form.account_id) {
			clearCreateOptions();
			return;
		}

		regionLoading = true;
		regionError = '';
		try {
			const params = new URLSearchParams({ account_id: String(form.account_id) });
			regions = await api<AzureRegionOption[]>(`/api/user/azure/region/list?${params.toString()}`);
			if (regions.length && !regions.some((region) => region.name === form.location)) {
				form.location = regions[0].name;
			}
			await loadCreateOptions();
		} catch (err) {
			regions = [];
			vmSizes = [];
			vmImages = [];
			regionError = err instanceof Error ? err.message : '区域识别失败';
			toast = regionError;
		} finally {
			regionLoading = false;
		}
	}

	async function loadVmSizes(requestId: number) {
		if (!form.account_id || !form.location.trim()) {
			vmSizes = [];
			sizeError = '';
			sizeLoading = false;
			return;
		}

		sizeLoading = true;
		sizeError = '';
		try {
			const params = new URLSearchParams({
				account_id: String(form.account_id),
				location: form.location.trim()
			});
			const result = await api<{ sizes: VmSizeOption[] }>(`/api/user/azure/vm/sizes?${params.toString()}`);
			if (requestId !== createOptionsRequestId) return;
			vmSizes = result.sizes ?? [];
			if (vmSizes.length && !vmSizes.some((size) => size.name === form.vm_size)) {
				form.vm_size = vmSizes[0].name;
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
		if (!form.account_id || !form.location.trim()) {
			vmImages = [];
			imageError = '';
			imageLoading = false;
			return;
		}

		imageLoading = true;
		imageError = '';
		try {
			const params = new URLSearchParams({
				account_id: String(form.account_id),
				location: form.location.trim()
			});
			const images = await api<VmImageOption[]>(`/api/user/azure/image/list?${params.toString()}`);
			if (requestId !== createOptionsRequestId) return;
			vmImages = images ?? [];
			if (
				vmImages.length &&
				!vmImages.some((image) => image.imageReference === form.image_reference)
			) {
				form.image_reference = vmImages[0].imageReference;
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
		const requestId = ++createOptionsRequestId;
		await Promise.all([loadVmSizes(requestId), loadVmImages(requestId)]);
	}

	async function changeAccount() {
		statusResult = null;
		await loadRegions();
	}

	async function changeLocation() {
		await loadCreateOptions();
	}

	async function submit(e: Event) {
		e.preventDefault();
		if (accounts.length === 0) {
			toast = 'Azure 号池为空，请先添加账号入池';
			return;
		}
		const vm_names = form.vm_names
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);

		try {
			await api('/api/user/workflow/add', {
				method: 'POST',
				body: JSON.stringify({
					...form,
					account_id: Number(form.account_id),
					vm_names,
					min_running_count: Number(form.replenish_target_count),
					replenish_target_count: Number(form.replenish_target_count),
					ip_brush_max_attempts: Number(form.ip_brush_max_attempts),
					check_interval_seconds: Number(form.check_interval_seconds),
					dns_binding_id: Number(form.dns_binding_id || 0),
					status_check_enabled: form.status_check_enabled
				})
			});
			toast = '补机策略已创建';
			statusResult = null;
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : '创建失败';
		}
	}

	async function checkAccountStatus() {
		if (!form.account_id) {
			toast = '请先从 Azure 号池选择触发检测账号';
			return;
		}
		checkingStatus = true;
		statusResult = null;
		try {
			const params = new URLSearchParams({
				account_id: String(form.account_id)
			});
			statusResult = await api<AccountStatus>(`/api/user/azure/account/status?${params.toString()}`);
			toast = statusResult.should_run_workflow
				? `账号状态 ${statusResult.state}，会触发自动补机`
				: `账号状态 ${statusResult.state}，不会触发自动补机`;
		} catch (err) {
			toast = err instanceof Error ? err.message : '检测账号状态失败';
		} finally {
			checkingStatus = false;
		}
	}

	async function toggle(workflow: Workflow) {
		await api(`/api/user/workflow/${workflow.id}`, {
			method: 'PUT',
			body: JSON.stringify({ enabled: !workflow.enabled })
		});
		await load();
	}

	async function remove(id: number) {
		if (!confirm('确认删除这个策略吗？')) return;
		await api(`/api/user/workflow/${id}`, { method: 'DELETE' });
		await load();
	}

	async function runNow() {
		await api('/api/user/workflow/run', { method: 'POST' });
		toast = '已触发 Azure 号池补机检查，请到执行日志查看结果';
	}

	onMount(() => {
		void load();
	});
</script>

<h1 class="mb-4 text-2xl font-semibold">自动补机</h1>

{#if toast}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm">{toast}</div>
{/if}

<div class="grid gap-6 xl:grid-cols-2">
	<form class="card space-y-3 p-5" onsubmit={submit}>
		<h2 class="text-lg font-medium">创建补机策略</h2>
		<div>
			<div class="mb-1 flex items-center justify-between gap-3">
				<label class="block text-xs text-muted" for="workflow-account-pool">Azure 号池</label>
				<span class="badge bg-primary/10 text-primary">剩余 {accounts.length} 个</span>
			</div>
			<select
				id="workflow-account-pool"
				class="input"
				bind:value={form.account_id}
				onchange={() => void changeAccount()}
				required
			>
				<option value="">从 Azure 号池选择触发检测账号</option>
				{#each accounts as account}
					<option value={account.id}>{account.name}</option>
				{/each}
			</select>
			<p class="mt-1 text-xs text-muted">
				这里选择的账号只用于状态触发检测和加载区域/规格/系统；真正自动补机时会从 Azure 号池随机抽取状态正常的账号创建 VM。
			</p>
		</div>
		<input class="input" bind:value={form.name} placeholder="策略名称" required />
		<input class="input" bind:value={form.resource_group} placeholder="资源组" required />
		<div>
			<label class="mb-1 block text-xs text-muted" for="workflow-location-select">补机开启区域</label>
			<select
				id="workflow-location-select"
				class="input"
				bind:value={form.location}
				onchange={() => void changeLocation()}
				disabled={regionLoading || regions.length === 0}
				required
			>
				{#if regionLoading}
					<option value={form.location}>正在从官方 API 查询可开区域...</option>
				{:else if regions.length === 0}
					<option value={form.location}>{regionError || '请先从 Azure 号池选择账号加载可开区域'}</option>
				{:else}
					{#each regions as region}
						<option value={region.name}>{regionLabel(region)}</option>
					{/each}
				{/if}
			</select>
			{#if regionError}
				<p class="mt-1 text-xs text-red-300">{regionError}</p>
			{/if}
		</div>
		<input
			class="input"
			bind:value={form.vm_names}
			placeholder="绑定已有补机 VM（逗号分隔，可留空）"
		/>
		<input
			class="input"
			type="number"
			bind:value={form.replenish_target_count}
			min="1"
			placeholder="异常时目标补机数量"
		/>
		<p class="text-xs text-muted">
			只有当前触发检测账号的订阅状态为 banned、warning 或 warned 时才会执行自动补机；补机账号会从 Azure 号池随机抽取正常订阅账号。
		</p>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={form.auto_start} /> 自动启动已停止的 VM
		</label>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={form.auto_create} /> 数量不足时自动创建新 VM
		</label>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={form.status_check_enabled} /> 自动定时检测账号/订阅状态
		</label>
		<button class="btn-secondary" type="button" disabled={checkingStatus} onclick={() => void checkAccountStatus()}>
			{checkingStatus ? '检测中...' : '检测触发账号状态'}
		</button>
		{#if statusResult}
			<div
				class={`rounded-lg border px-3 py-2 text-xs ${
					statusResult.should_run_workflow
						? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
						: 'border-green-500/40 bg-green-500/10 text-green-100'
				}`}
			>
				订阅 {statusResult.display_name || statusResult.subscription_id} 当前状态：{statusResult.state}。
				{statusResult.should_run_workflow
					? '命中触发条件，会从 Azure 号池随机抽取正常账号补机。'
					: '未命中触发条件，不会执行补机。'}
			</div>
		{/if}
		<div>
			<label class="mb-1 block text-xs text-muted" for="workflow-size-select">补机实例规格</label>
			<select
				id="workflow-size-select"
				class="input"
				bind:value={form.vm_size}
				disabled={sizeLoading || vmSizes.length === 0}
				required
			>
				{#if sizeLoading}
					<option value={form.vm_size}>正在从官方 API 查询实例规格...</option>
				{:else if vmSizes.length === 0}
					<option value={form.vm_size}>{sizeError || '请先选择账号和区域加载规格'}</option>
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
		<div>
			<label class="mb-1 block text-xs text-muted" for="workflow-image-select">安装系统</label>
			<select
				id="workflow-image-select"
				class="input"
				bind:value={form.image_reference}
				disabled={imageLoading || vmImages.length === 0}
				required
			>
				{#if imageLoading}
					<option value={form.image_reference}>正在从官方 API 查询安装系统...</option>
				{:else if vmImages.length === 0}
					<option value={form.image_reference}>{imageError || '请先选择账号和区域加载系统'}</option>
				{:else}
					{#each vmImages as image}
						<option value={image.imageReference}>{imageLabel(image)}</option>
					{/each}
				{/if}
			</select>
			{#if imageError}
				<p class="mt-1 text-xs text-red-300">{imageError}</p>
			{/if}
			<p class="mt-1 break-all text-xs text-muted">{form.image_reference}</p>
		</div>
		<input class="input" bind:value={form.name_prefix} placeholder="自动创建 VM 前缀" />
		<input class="input" bind:value={form.admin_username} placeholder="管理员用户名" />
		<input
			class="input"
			type="password"
			bind:value={form.admin_password}
			placeholder="自动创建 VM 密码"
		/>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={form.enable_ipv6} /> 自动补机时同时创建 IPv6 公网地址
		</label>
		<div class="grid gap-3 sm:grid-cols-2">
			<input
				class="input"
				bind:value={form.ip_prefix}
				placeholder="补机目标 IPv4 前缀，留空默认 85.211"
			/>
			<input
				class="input"
				type="number"
				bind:value={form.ip_brush_max_attempts}
				min="1"
				max="500"
				placeholder="最大刷 IP 次数"
			/>
		</div>
		<textarea
			class="input min-h-36 font-mono text-xs"
			bind:value={form.userdata}
			placeholder={`#cloud-config\nruncmd:\n  - curl -fsSL https://example.com/install.sh | bash`}
		></textarea>
		<select class="input" bind:value={form.dns_binding_id}>
			<option value="">补机完成后 DNS 解析绑定（可选）</option>
			{#each dnsBindings as binding}
				<option value={binding.id} disabled={!binding.enabled}>
					{binding.name} · {binding.fqdn}{binding.enabled ? '' : '（已停用）'}
				</option>
			{/each}
		</select>
		<input
			class="input"
			type="number"
			bind:value={form.check_interval_seconds}
			min="1"
			placeholder="定时检测间隔（秒，留空默认 120）"
		/>
		<button class="btn-primary" type="submit">创建策略</button>
	</form>

	<div class="space-y-4">
		<div class="flex items-center justify-between">
			<h2 class="text-lg font-medium">策略列表</h2>
			<button class="btn-secondary" onclick={() => void runNow()}>立即执行补机</button>
		</div>
		{#each workflows as workflow}
			<div class="card p-4">
				<div class="flex justify-between gap-3">
					<div>
						<div class="font-medium">
							{workflow.name}
							<span
								class={`badge ml-2 ${
									workflow.enabled
										? 'bg-green-900/50 text-green-300'
										: 'bg-red-900/50 text-red-300'
								}`}
							>
								{workflow.enabled ? '启用' : '停用'}
							</span>
						</div>
						<p class="mt-2 text-sm text-muted">
							资源组 {workflow.resource_group} · 目标补机 {workflow.replenish_target_count || workflow.min_running_count}
						</p>
						<p class="text-xs text-muted">
							自动开机: {workflow.auto_start ? '是' : '否'} · 自动补机: {workflow.auto_create
								? '是'
								: '否'} · 间隔 {workflow.check_interval_seconds}s
						</p>
						<p class="text-xs text-muted">
							状态检测: {workflow.status_check_enabled ? '开启' : '关闭'} · 触发状态: banned / warning / warned ·
							上次状态: {workflow.last_account_status || '-'}
						</p>
						<p class="text-xs text-muted">
							DNS 绑定: {workflow.dns_binding_id
								? dnsBindings.find((binding) => binding.id === workflow.dns_binding_id)?.fqdn || workflow.dns_binding_id
								: '-'}
						</p>
						<p class="text-xs text-muted">
							IPv6: {workflow.enable_ipv6 ? '是' : '否'} · IPv4 前缀: {workflow.ip_prefix || '-'} · UserData: {workflow.userdata_configured
								? '已配置'
								: '未配置'}
						</p>
					</div>
					<div class="space-y-2">
						<button class="btn-secondary" onclick={() => void toggle(workflow)}>
							{workflow.enabled ? '停用' : '启用'}
						</button>
						<button class="btn-danger" onclick={() => void remove(workflow.id)}>删除</button>
					</div>
				</div>
			</div>
		{:else}
			<p class="text-sm text-muted">还没有补机策略</p>
		{/each}
	</div>
</div>
