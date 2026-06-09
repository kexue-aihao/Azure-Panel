<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { createTranslator, normalizeLanguage, type LanguageCode } from '$lib/i18n';

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
		publisher: string;
		offer: string;
		sku: string;
		version: string;
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
		account_id: number;
		name: string;
		enabled: boolean;
		resource_group: string;
		location: string;
		vm_names: string[];
		min_running_count: number;
		replenish_target_count: number;
		auto_start: boolean;
		auto_create: boolean;
		vm_size: string;
		image_reference: string;
		name_prefix: string;
		admin_username: string;
		enable_ipv6: boolean;
		enable_accelerated_networking: boolean;
		enable_ddos_protection: boolean;
		ip_prefix: string;
		ip_brush_max_attempts: number;
		userdata_configured: boolean;
		check_interval_seconds: number;
		status_check_enabled: boolean;
		status_trigger_states: string;
		replenishment_account_order: string;
		dns_binding_id: number;
		last_account_status: string;
		last_status_checked_at: string | null;
	};

	const accountOrderOptions = [
		{ value: 'pool_added_at', label: '按加入 Azure 号池时间（默认）' },
		{ value: 'subscription_enabled_at', label: '按账号订阅启用时间' },
		{ value: 'azure_registered_at', label: '按 Azure 账号注册时间' }
	];

	function defaultWorkflowForm() {
		return {
			account_id: '',
			name: '',
			resource_group: '',
			location: 'eastus',
			vm_names: '',
			min_running_count: 1,
			replenish_target_count: 1,
			auto_start: true,
			auto_create: true,
			vm_size: 'Standard_B1s',
			image_reference: 'Canonical:ubuntu-24_04-lts:server:latest',
			name_prefix: 'auto-vm',
			admin_username: 'azureuser',
			admin_password: '',
			userdata: '',
			enable_ipv6: true,
			enable_accelerated_networking: false,
			enable_ddos_protection: false,
			ip_prefix: '85.211',
			ip_brush_max_attempts: 30,
			check_interval_seconds: 60,
			status_check_enabled: true,
			status_trigger_states: 'banned,warning,warned,disabled',
			replenishment_account_order: 'pool_added_at',
			dns_binding_id: ''
		};
	}

	let accounts = $state<Account[]>([]);
	let dnsBindings = $state<DnsBinding[]>([]);
	let regions = $state<AzureRegionOption[]>([]);
	let vmSizes = $state<VmSizeOption[]>([]);
	let vmImages = $state<VmImageOption[]>([]);
	let workflows = $state<Workflow[]>([]);
	let form = $state(defaultWorkflowForm());
	let editingWorkflowId = $state<number | null>(null);
	let savingWorkflow = $state(false);
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
	let language = $state<LanguageCode>('zh');
	let t = $derived(createTranslator(language));

	function syncLanguage() {
		language = normalizeLanguage(localStorage.getItem('language'));
	}

	function randomSuffix(length = 10) {
		const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
		const cryptoApi = globalThis.crypto;
		let value = '';
		if (cryptoApi?.getRandomValues) {
			const bytes = new Uint8Array(length);
			cryptoApi.getRandomValues(bytes);
			for (const byte of bytes) value += chars[byte % chars.length];
			return value;
		}
		for (let i = 0; i < length; i += 1) {
			value += chars[Math.floor(Math.random() * chars.length)];
		}
		return value;
	}

	function randomResourceGroupName() {
		return `rg-auto-${randomSuffix(10)}`;
	}

	function fillRandomResourceGroup() {
		form.resource_group = randomResourceGroupName();
	}

	function resetForm() {
		editingWorkflowId = null;
		statusResult = null;
		form = defaultWorkflowForm();
		clearCreateOptions();
		fillRandomResourceGroup();
	}

	function workflowPayload() {
		const vmNames = form.vm_names
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const payload: Record<string, unknown> = {
			...form,
			account_id: Number(form.account_id),
			vm_names: vmNames,
			min_running_count: Number(form.replenish_target_count),
			replenish_target_count: Number(form.replenish_target_count),
			check_interval_seconds: 60,
			dns_binding_id: Number(form.dns_binding_id || 0),
			status_check_enabled: form.status_check_enabled,
			replenishment_account_order: form.replenishment_account_order,
			auto_create: true
		};

		if (editingWorkflowId) {
			if (!form.admin_password.trim()) delete payload.admin_password;
			if (!form.userdata.trim()) delete payload.userdata;
		}

		return payload;
	}

	async function editWorkflow(workflow: Workflow) {
		editingWorkflowId = workflow.id;
		statusResult = null;
		form = {
			...defaultWorkflowForm(),
			account_id: String(workflow.account_id || ''),
			name: workflow.name,
			resource_group: workflow.resource_group,
			location: workflow.location || 'eastus',
			vm_names: (workflow.vm_names ?? []).join(', '),
			min_running_count: workflow.min_running_count,
			replenish_target_count: workflow.replenish_target_count || workflow.min_running_count || 1,
			auto_start: workflow.auto_start,
			auto_create: true,
			vm_size: workflow.vm_size || 'Standard_B1s',
			image_reference: workflow.image_reference || 'Canonical:ubuntu-24_04-lts:server:latest',
			name_prefix: workflow.name_prefix || 'auto-vm',
			admin_username: workflow.admin_username || 'azureuser',
			enable_ipv6: workflow.enable_ipv6,
			enable_accelerated_networking: workflow.enable_accelerated_networking,
			enable_ddos_protection: workflow.enable_ddos_protection,
			ip_prefix: workflow.ip_prefix || '85.211',
			ip_brush_max_attempts: workflow.ip_brush_max_attempts || 30,
			check_interval_seconds: 60,
			status_check_enabled: workflow.status_check_enabled,
			status_trigger_states: workflow.status_trigger_states || 'banned,warning,warned,disabled',
			replenishment_account_order: workflow.replenishment_account_order || 'pool_added_at',
			dns_binding_id: workflow.dns_binding_id ? String(workflow.dns_binding_id) : ''
		};
		await loadRegions(true);
		globalThis.scrollTo?.({ top: 0, behavior: 'smooth' });
	}

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
			size.quota_remaining > 0 && size.quota_required > 0
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

	function hasRegionOption(location: string) {
		return regions.some((region) => region.name === location);
	}

	function hasVmSizeOption(sizeName: string) {
		return vmSizes.some((size) => size.name === sizeName);
	}

	function hasVmImageOption(imageReference: string) {
		return vmImages.some((image) => image.imageReference === imageReference);
	}

	function sameImageFamily(imageReference: string, image: VmImageOption) {
		const parts = imageReference.split(':');
		return (
			parts.length >= 3 &&
			parts[0] === image.publisher &&
			parts[1] === image.offer &&
			parts[2] === image.sku
		);
	}

	async function load() {
		accounts = await api<Account[]>('/api/user/azure/account/list');
		dnsBindings = await api<DnsBinding[]>('/api/user/dns/binding/list');
		workflows = await api<Workflow[]>('/api/user/workflow/list');
	}

	async function loadRegions(preserveCurrent = false) {
		if (!form.account_id) {
			clearCreateOptions();
			return;
		}

		regionLoading = true;
		regionError = '';
		try {
			const params = new URLSearchParams({ account_id: String(form.account_id) });
			params.set('fast', '1');
			regions = await api<AzureRegionOption[]>(`/api/user/azure/region/list?${params.toString()}`);
			if (regions.length && !hasRegionOption(form.location) && !preserveCurrent) {
				form.location = regions[0].name;
			}
			await loadCreateOptions(preserveCurrent);

			const refreshParams = new URLSearchParams({
				account_id: String(form.account_id),
				refresh: '1'
			});
			void api<AzureRegionOption[]>(`/api/user/azure/region/list?${refreshParams.toString()}`)
				.then((officialRegions) => {
					if (!officialRegions?.length) return;
					regions = officialRegions;
					if (!hasRegionOption(form.location) && !preserveCurrent) {
						form.location = regions[0].name;
						void loadCreateOptions(preserveCurrent);
					}
				})
				.catch(() => {
					// Fast region list is already usable; official refresh is best effort.
				});
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

	async function loadVmSizes(requestId: number, preserveCurrent = false) {
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
			params.set('fast', '1');
			const result = await api<{ sizes: VmSizeOption[] }>(`/api/user/azure/vm/sizes?${params.toString()}`);
			if (requestId !== createOptionsRequestId) return;
			vmSizes = result.sizes ?? [];
			if (vmSizes.length && !hasVmSizeOption(form.vm_size) && !preserveCurrent) {
				form.vm_size = vmSizes[0].name;
			}
		} catch (err) {
			if (requestId !== createOptionsRequestId) return;
			sizeError = err instanceof Error ? err.message : '规格查询失败';
		} finally {
			if (requestId === createOptionsRequestId) sizeLoading = false;
		}

		if (requestId !== createOptionsRequestId) return;
		const refreshParams = new URLSearchParams({
			account_id: String(form.account_id),
			location: form.location.trim()
		});
		void api<{ sizes: VmSizeOption[] }>(`/api/user/azure/vm/sizes?${refreshParams.toString()}`)
			.then((result) => {
				if (requestId !== createOptionsRequestId || !result.sizes?.length) return;
				const selected = result.sizes.find((size) => size.name === form.vm_size);
				vmSizes = result.sizes;
				if (!selected && !preserveCurrent) form.vm_size = vmSizes[0].name;
			})
			.catch((err) => {
				if (requestId !== createOptionsRequestId) return;
				sizeError = err instanceof Error ? err.message : 'Azure 官方规格刷新失败';
			});
	}

	async function loadVmImages(requestId: number, preserveCurrent = false) {
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
			params.set('fast', '1');
			const images = await api<VmImageOption[]>(`/api/user/azure/image/list?${params.toString()}`);
			if (requestId !== createOptionsRequestId) return;
			vmImages = images ?? [];
			if (vmImages.length && !hasVmImageOption(form.image_reference) && !preserveCurrent) {
				form.image_reference = vmImages[0].imageReference;
			}
		} catch (err) {
			if (requestId !== createOptionsRequestId) return;
			imageError = err instanceof Error ? err.message : '系统镜像查询失败';
		} finally {
			if (requestId === createOptionsRequestId) imageLoading = false;
		}

		if (requestId !== createOptionsRequestId) return;
		const refreshParams = new URLSearchParams({
			account_id: String(form.account_id),
			location: form.location.trim(),
			refresh: '1'
		});
		void api<VmImageOption[]>(`/api/user/azure/image/list?${refreshParams.toString()}`)
			.then((images) => {
				if (requestId !== createOptionsRequestId || !images?.length) return;
				const selectedImage = images.find(
					(image) =>
						image.imageReference === form.image_reference ||
						sameImageFamily(form.image_reference, image)
				);
				vmImages = images;
				if (selectedImage) {
					form.image_reference = selectedImage.imageReference;
				} else if (!preserveCurrent) {
					form.image_reference = vmImages[0].imageReference;
				}
			})
			.catch((err) => {
				if (requestId !== createOptionsRequestId) return;
				imageError = err instanceof Error ? err.message : 'Azure 官方系统镜像刷新失败';
			});
	}

	async function loadCreateOptions(preserveCurrent = false) {
		const requestId = ++createOptionsRequestId;
		await Promise.all([
			loadVmSizes(requestId, preserveCurrent),
			loadVmImages(requestId, preserveCurrent)
		]);
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
		if (!form.account_id) {
			toast = '请先从 Azure 号池选择触发检测账号';
			return;
		}
		if (!form.dns_binding_id) {
			toast = '请先选择自动补机完成后要解析的 DNS 绑定';
			return;
		}

		savingWorkflow = true;
		try {
			await api(editingWorkflowId ? `/api/user/workflow/${editingWorkflowId}` : '/api/user/workflow/add', {
				method: editingWorkflowId ? 'PUT' : 'POST',
				body: JSON.stringify(workflowPayload())
			});
			toast = editingWorkflowId ? '补机策略已更新' : '补机策略已创建';
			resetForm();
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : editingWorkflowId ? '更新失败' : '创建失败';
		} finally {
			savingWorkflow = false;
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
		if (editingWorkflowId === id) resetForm();
		await api(`/api/user/workflow/${id}`, { method: 'DELETE' });
		await load();
	}

	async function runNow() {
		await api('/api/user/workflow/run', { method: 'POST' });
		toast = '已触发 Azure 号池补机检查，请到执行日志查看结果';
	}

	onMount(() => {
		syncLanguage();
		const onLanguage = (event: Event) => {
			language = normalizeLanguage((event as CustomEvent).detail);
		};
		window.addEventListener('azure-panel-language-change', onLanguage);
		fillRandomResourceGroup();
		void load();
		return () => window.removeEventListener('azure-panel-language-change', onLanguage);
	});
</script>

<h1 class="mb-4 text-2xl font-semibold">{t('workflow.title')}</h1>

{#if toast}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm">{toast}</div>
{/if}

<div class="grid gap-6 xl:grid-cols-2">
	<form class="card space-y-3 p-5" onsubmit={submit}>
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<h2 class="text-lg font-medium">{editingWorkflowId ? '编辑补机策略' : '创建补机策略'}</h2>
				{#if editingWorkflowId}
					<p class="mt-1 text-xs text-muted">
						正在编辑策略 #{editingWorkflowId}。密码和 UserData 留空会保留原配置，不会清空。
					</p>
				{/if}
			</div>
			{#if editingWorkflowId}
				<button class="btn-secondary" type="button" onclick={resetForm}>取消编辑</button>
			{/if}
		</div>
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
				这里选择的账号只用于状态触发检测和加载区域/规格/系统；真正自动补机时会从 Azure 号池按添加顺序选择状态正常的账号创建 VM。
			</p>
		</div>
		<input class="input" bind:value={form.name} placeholder="策略名称" required />
		<div class="flex gap-2">
			<input class="input" bind:value={form.resource_group} placeholder="资源组" required />
			<button class="btn-secondary shrink-0" type="button" onclick={fillRandomResourceGroup}>换一个</button>
		</div>
		<div>
			<label class="mb-1 block text-xs text-muted" for="workflow-location-select">补机开启区域</label>
			<select
				id="workflow-location-select"
				class="input"
				bind:value={form.location}
				onchange={() => void changeLocation()}
				disabled={regions.length === 0}
				required
			>
				{#if regionLoading && regions.length === 0}
					<option value={form.location}>正在从官方 API 查询可开区域...</option>
				{:else if regions.length === 0}
					<option value={form.location}>{regionError || '请先从 Azure 号池选择账号加载可开区域'}</option>
				{:else}
					{#if form.location && !hasRegionOption(form.location)}
						<option value={form.location}>当前已保存区域：{form.location}</option>
					{/if}
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
			只有当前触发检测账号的订阅状态为 banned、warning、warned 或 disabled 时才会执行自动补机；补机账号会从 Azure 号池按下方排序方式选择正常订阅账号。
		</p>
		<div>
			<label class="mb-1 block text-xs text-muted" for="workflow-account-order">补机账号使用顺序</label>
			<select id="workflow-account-order" class="input" bind:value={form.replenishment_account_order}>
				{#each accountOrderOptions as option}
					<option value={option.value}>{option.label}</option>
				{/each}
			</select>
			<p class="mt-1 text-xs text-muted">
				如果账号未记录订阅启用时间或 Azure 注册时间，会自动回退为加入 Azure 号池时间，默认使用加入号池时间。
			</p>
		</div>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={form.auto_start} /> 自动启动已停止的 VM
		</label>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={form.status_check_enabled} /> 每 60 秒检测正在使用账号订阅状态，异常立即触发补机，上一轮补机未完成时跳过本轮
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
					? '命中触发条件，会从 Azure 号池按添加顺序选择正常账号补机。'
					: '未命中触发条件，不会执行补机。'}
			</div>
		{/if}
		<div>
			<label class="mb-1 block text-xs text-muted" for="workflow-size-select">补机实例规格</label>
			<select
				id="workflow-size-select"
				class="input"
				bind:value={form.vm_size}
				disabled={vmSizes.length === 0}
				required
			>
				{#if sizeLoading && vmSizes.length === 0}
					<option value={form.vm_size}>正在从官方 API 查询实例规格...</option>
				{:else if vmSizes.length === 0}
					<option value={form.vm_size}>{sizeError || '请先选择账号和区域加载规格'}</option>
				{:else}
					{#if form.vm_size && !hasVmSizeOption(form.vm_size)}
						<option value={form.vm_size}>当前已保存规格：{form.vm_size}</option>
					{/if}
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
				disabled={vmImages.length === 0}
				required
			>
				{#if imageLoading && vmImages.length === 0}
					<option value={form.image_reference}>正在从官方 API 查询安装系统...</option>
				{:else if vmImages.length === 0}
					<option value={form.image_reference}>{imageError || '请先选择账号和区域加载系统'}</option>
				{:else}
					{#if form.image_reference && !hasVmImageOption(form.image_reference)}
						<option value={form.image_reference}>当前已保存系统：{form.image_reference}</option>
					{/if}
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
			placeholder={editingWorkflowId ? '新自动创建 VM 密码，留空不修改' : '自动创建 VM 密码'}
		/>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={form.enable_ipv6} /> 自动补机时同时创建 IPv6 公网地址
		</label>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={form.enable_accelerated_networking} />
			{t('workflow.enable_accelerated_networking')}
		</label>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={form.enable_ddos_protection} />
			{t('workflow.enable_ddos_protection')}
		</label>
		<p class="-mt-2 text-xs text-muted">
			自动补机会默认刷 IPv4 前缀 85.211，最多尝试 30 次；成功后同步创建/更新 DNS 解析。
		</p>
		<textarea
			class="input min-h-36 font-mono text-xs"
			bind:value={form.userdata}
			placeholder={
				editingWorkflowId
					? `新的 UserData，留空不修改\n#cloud-config\nruncmd:\n  - curl -fsSL https://example.com/install.sh | bash`
					: `#cloud-config\nruncmd:\n  - curl -fsSL https://example.com/install.sh | bash`
			}
		></textarea>
		<select class="input" bind:value={form.dns_binding_id} required>
			<option value="">请选择补机完成后 DNS 解析绑定（必选）</option>
			{#each dnsBindings as binding}
				<option value={binding.id} disabled={!binding.enabled}>
					{binding.name} · {binding.fqdn}{binding.enabled ? '' : '（已停用）'}
				</option>
			{/each}
		</select>
		<p class="rounded-lg border border-border bg-background/70 px-3 py-2 text-xs text-muted">
			补机触发逻辑固定为每 60 秒检测一次当前正在使用账号的订阅状态；检测到 banned、warning、warned 或 disabled 后立即按所选顺序选择号池账号补机；补机会刷 IPv4 前缀 85.211，默认最多 30 次；上一轮补机流程未完成前不会再次触发检测。
		</p>
		<div class="flex flex-wrap gap-2">
			<button class="btn-primary" type="submit" disabled={savingWorkflow}>
				{savingWorkflow ? '保存中...' : editingWorkflowId ? '保存策略修改' : '创建策略'}
			</button>
			{#if editingWorkflowId}
				<button class="btn-secondary" type="button" onclick={resetForm} disabled={savingWorkflow}>
					取消编辑
				</button>
			{/if}
		</div>
	</form>

	<div class="space-y-4">
		<div class="flex items-center justify-between">
			<h2 class="text-lg font-medium">策略列表</h2>
			<button class="btn-secondary" onclick={() => void runNow()}>立即执行补机</button>
		</div>
		{#each workflows as workflow}
			<div class={`card p-4 ${editingWorkflowId === workflow.id ? 'border-primary/70 bg-primary/5' : ''}`}>
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
							{#if editingWorkflowId === workflow.id}
								<span class="badge ml-2 bg-primary/20 text-primary">编辑中</span>
							{/if}
						</div>
						<p class="mt-2 text-sm text-muted">
							资源组 {workflow.resource_group} · 区域 {workflow.location || '-'} · 规格 {workflow.vm_size || '-'} · 目标补机 {workflow.replenish_target_count || workflow.min_running_count}
						</p>
						<p class="text-xs text-muted">
							系统: {workflow.image_reference || '-'}
						</p>
						<p class="text-xs text-muted">
							自动开机: {workflow.auto_start ? '是' : '否'} · 自动补机: 异常立即创建 · 订阅检测 60s · IPv4 前缀 {workflow.ip_prefix || '85.211'} / {workflow.ip_brush_max_attempts || 30} 次
						</p>
						<p class="text-xs text-muted">
							补机账号顺序: {accountOrderOptions.find((option) => option.value === workflow.replenishment_account_order)?.label || '按加入 Azure 号池时间（默认）'}
						</p>
						<p class="text-xs text-muted">
							状态检测: {workflow.status_check_enabled ? '开启' : '关闭'} · 触发状态: banned / warning / warned / disabled ·
							上次状态: {workflow.last_account_status || '-'}
						</p>
						<p class="text-xs text-muted">
							DNS 绑定: {workflow.dns_binding_id
								? dnsBindings.find((binding) => binding.id === workflow.dns_binding_id)?.fqdn || workflow.dns_binding_id
								: '-'}
						</p>
						<p class="text-xs text-muted">
							IPv6: {workflow.enable_ipv6 ? '是' : '否'} · UserData: {workflow.userdata_configured
								? '已配置'
								: '未配置'}
						</p>
						<p class="text-xs text-muted">
							{t('workflow.accelerated_networking')}: {workflow.enable_accelerated_networking ? t('common.yes') : t('common.no')} ·
							{t('workflow.ddos_protection')}: {workflow.enable_ddos_protection ? t('common.yes') : t('common.no')}
						</p>
					</div>
					<div class="space-y-2">
						<button class="btn-secondary" onclick={() => void editWorkflow(workflow)}>编辑</button>
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
