<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Account = { id: number; name: string; subscription_id: string };
	type Subscription = {
		subscription_id: string;
		display_name: string;
		state: string;
		is_default: boolean;
	};
	type ResourceGroup = {
		id: string;
		name: string;
		location: string;
		provisioning_state: string;
	};
	type Resource = {
		id: string;
		name: string;
		type: string;
		location: string;
		resource_group: string;
		kind: string;
		sku_name: string;
		provisioning_state: string;
	};
	type ProviderStatus = {
		namespace: string;
		registrationState: string;
		registrationPolicy: string;
		resourceTypeCount: number;
		locations: string[];
	};
	type AiAccount = {
		id: string;
		name: string;
		resource_group: string;
		location: string;
		kind: string;
		sku_name: string;
		endpoint: string;
		provisioning_state: string;
		public_network_access: string;
	};
	type AiKeys = { endpoint: string; key1: string; key2: string };
	type AiDeployment = {
		id: string;
		name: string;
		resource_group: string;
		account_name: string;
		model_format: string;
		model_name: string;
		model_version: string;
		scale_type: string;
		capacity: number;
		provisioning_state: string;
	};
	type ProgressStatus = 'running' | 'success' | 'error' | 'info';
	type ResourceGroupDeleteProgressEvent = {
		step: string;
		status: ProgressStatus;
		message: string;
		detail?: Record<string, string | number | boolean | null>;
		timestamp: string;
	};
	type ResourceGroupDeleteResult = {
		resource_group: string;
		status: 'success' | 'error';
		message: string;
	};
	type ResourceGroupDeleteStreamResult = {
		results: ResourceGroupDeleteResult[];
		success: number;
		failed: number;
	};
	type ResourceGroupDeleteStreamMessage =
		| { type: 'progress'; event: ResourceGroupDeleteProgressEvent }
		| { type: 'result'; result: ResourceGroupDeleteStreamResult }
		| { type: 'error'; message: string };
	type ProviderRegisterStreamResult = {
		subscription_id: string;
		providers: ProviderStatus[];
	};
	type ProviderRegisterStreamMessage =
		| { type: 'progress'; event: ResourceGroupDeleteProgressEvent }
		| { type: 'result'; result: ProviderRegisterStreamResult }
		| { type: 'error'; message: string };

	let accounts = $state<Account[]>([]);
	let subscriptions = $state<Subscription[]>([]);
	let groups = $state<ResourceGroup[]>([]);
	let resources = $state<Resource[]>([]);
	let providers = $state<ProviderStatus[]>([]);
	let aiAccounts = $state<AiAccount[]>([]);
	let deployments = $state<AiDeployment[]>([]);
	let accountId = $state<number | null>(null);
	let subscriptionId = $state('');
	let resourceGroup = $state('');
	let resourceType = $state('');
	let selectedAiAccount = $state<AiAccount | null>(null);
	let aiKeys = $state<AiKeys | null>(null);
	let loading = $state(false);
	let providerLoading = $state(false);
	let aiLoading = $state(false);
	let deploymentLoading = $state(false);
	let deletingGroups = $state(false);
	let selectedResourceGroups = $state<string[]>([]);
	let deleteProgress = $state<ResourceGroupDeleteProgressEvent[]>([]);
	let deleteResults = $state<ResourceGroupDeleteResult[]>([]);
	let providerProgress = $state<ResourceGroupDeleteProgressEvent[]>([]);
	let providerProgressResult = $state<ProviderRegisterStreamResult | null>(null);
	let toast = $state('');
	let createAiForm = $state({
		resource_group: '',
		location: 'eastus',
		account_name: '',
		kind: 'OpenAI',
		sku_name: 'S0'
	});
	let deploymentForm = $state({
		deployment_name: '',
		model_format: 'OpenAI',
		model_name: 'gpt-4o-mini',
		model_version: '',
		scale_type: 'Standard',
		capacity: 1
	});

	const selectedGroup = $derived(groups.find((group) => group.name === resourceGroup) ?? null);
	const resourceTypeOptions = $derived(
		[...new Set(resources.map((resource) => resource.type).filter(Boolean))].sort()
	);
	const groupedResourceCounts = $derived(
		groups.map((group) => ({
			...group,
			count: resources.filter((resource) => resource.resource_group === group.name).length
		}))
	);
	const visibleResourceGroups = $derived(
		groupedResourceCounts.filter((group) => !resourceGroup || group.name === resourceGroup)
	);
	const visibleResourceGroupNames = $derived(visibleResourceGroups.map((group) => group.name));
	const allVisibleResourceGroupsSelected = $derived(
		visibleResourceGroupNames.length > 0 &&
			visibleResourceGroupNames.every((name) => selectedResourceGroups.includes(name))
	);
	const recentDeleteProgress = $derived(deleteProgress.slice(-12).reverse());
	const deleteProgressPercent = $derived(resourceGroupDeleteProgressPercent(deleteProgress));
	const recentProviderProgress = $derived(providerProgress.slice(-12).reverse());
	const providerProgressPercentValue = $derived(providerRegistrationProgressPercent(providerProgress));

	function params(extra: Record<string, string> = {}) {
		const query = new URLSearchParams({
			account_id: String(accountId ?? ''),
			...extra
		});
		if (subscriptionId) query.set('subscription_id', subscriptionId);
		return query;
	}

	function setToastFromError(err: unknown, fallback: string) {
		toast = err instanceof Error ? err.message : fallback;
	}

	function uniqueNames(names: string[]) {
		return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
	}

	function toggleResourceGroupSelection(name: string) {
		selectedResourceGroups = selectedResourceGroups.includes(name)
			? selectedResourceGroups.filter((item) => item !== name)
			: [...selectedResourceGroups, name];
	}

	function toggleVisibleResourceGroups() {
		selectedResourceGroups = allVisibleResourceGroupsSelected
			? selectedResourceGroups.filter((name) => !visibleResourceGroupNames.includes(name))
			: uniqueNames([...selectedResourceGroups, ...visibleResourceGroupNames]);
	}

	function clearResourceGroupSelection() {
		selectedResourceGroups = [];
	}

	function addDeleteProgress(event: ResourceGroupDeleteProgressEvent) {
		deleteProgress = [...deleteProgress, event].slice(-240);
	}

	function mergeProviderProgress(event: ResourceGroupDeleteProgressEvent) {
		const index = providerProgress.findIndex((item) => item.step === event.step);
		if (index === -1) {
			providerProgress = [...providerProgress, event].slice(-240);
			return;
		}
		providerProgress = providerProgress.map((item, itemIndex) =>
			itemIndex === index ? { ...item, ...event } : item
		);
	}

	function progressDetailNumber(
		detail: ResourceGroupDeleteProgressEvent['detail'],
		key: string
	) {
		const value = detail?.[key];
		return typeof value === 'number' ? value : Number(value || 0);
	}

	function resourceGroupDeleteProgressPercent(progress: ResourceGroupDeleteProgressEvent[]) {
		if (progress.length === 0) return deletingGroups ? 8 : 0;
		if (progress.some((item) => item.step === 'batch-complete')) return 100;
		const latest = progress.at(-1);
		const total = Math.max(
			1,
			progressDetailNumber(latest?.detail, 'total') || selectedResourceGroups.length || 1
		);
		const finishedGroups = new Set(
			progress
				.filter((item) => item.step === 'delete-group-complete' || item.step === 'delete-group-failed')
				.map((item) => String(item.detail?.resourceGroup ?? ''))
				.filter(Boolean)
		);
		const polls = progressDetailNumber(latest?.detail, 'polls');
		const currentWeight =
			latest?.status === 'running' ? Math.min(0.85, 0.18 + polls * 0.08) : latest?.status ? 0.45 : 0;
		return Math.min(95, Math.max(8, Math.round(((finishedGroups.size + currentWeight) / total) * 100)));
	}

	function providerRegistrationProgressPercent(progress: ResourceGroupDeleteProgressEvent[]) {
		if (progress.length === 0) return providerLoading ? 8 : 0;
		if (progress.some((item) => item.step === 'provider-complete' && item.status === 'success')) return 100;
		if (progress.some((item) => item.step === 'provider-failed' && item.status === 'error')) return 100;
		const latest = progress.at(-1);
		if (latest?.step === 'provider-cache') return latest.status === 'success' ? 98 : 95;
		const total = Math.max(1, progressDetailNumber(latest?.detail, 'total'));
		const index = progressDetailNumber(latest?.detail, 'index');
		if (index > 0) {
			const stepWeight = latest?.status === 'running' ? 0.45 : 0.9;
			return Math.min(95, Math.max(12, Math.round(12 + ((index - 1 + stepWeight) / total) * 83)));
		}
		if (progress.some((item) => item.step === 'provider-auth')) return 12;
		return 8;
	}

	function progressFinished(progress: ResourceGroupDeleteProgressEvent[]) {
		return progress.some((item) => item.step === 'batch-complete') || (!deletingGroups && progress.length > 0);
	}

	function providerProgressFinished(progress: ResourceGroupDeleteProgressEvent[]) {
		return (
			progress.some((item) => item.step === 'provider-complete' && item.status === 'success') ||
			progress.some((item) => item.step === 'provider-failed' && item.status === 'error') ||
			(!providerLoading && progress.length > 0 && progress.every((item) => item.status !== 'running'))
		);
	}

	function progressTone(progress: ResourceGroupDeleteProgressEvent[]) {
		if (deleteResults.length && deleteResults.every((item) => item.status === 'error')) return 'bg-red-500';
		if (deleteResults.some((item) => item.status === 'error')) return 'bg-yellow-500';
		if (progressFinished(progress)) return 'bg-green-500';
		return 'bg-primary';
	}

	function providerProgressTone(progress: ResourceGroupDeleteProgressEvent[]) {
		if (progress.some((item) => item.step === 'provider-failed' && item.status === 'error')) return 'bg-red-500';
		if (progress.some((item) => item.status === 'error')) return 'bg-yellow-500';
		if (providerProgressFinished(progress)) return 'bg-green-500';
		return 'bg-primary';
	}

	function progressAnimation(progress: ResourceGroupDeleteProgressEvent[]) {
		return !progressFinished(progress) && progress.some((item) => item.status === 'running') ? 'running' : '';
	}

	function providerProgressAnimation(progress: ResourceGroupDeleteProgressEvent[]) {
		return !providerProgressFinished(progress) && progress.some((item) => item.status === 'running')
			? 'running'
			: '';
	}

	function progressBadge(status: ProgressStatus) {
		if (status === 'success') return 'bg-green-900/50 text-green-300';
		if (status === 'error') return 'bg-red-900/50 text-red-300';
		if (status === 'info') return 'bg-blue-900/50 text-blue-200';
		return 'bg-yellow-900/50 text-yellow-300';
	}

	function progressText(status: ProgressStatus) {
		if (status === 'success') return '完成';
		if (status === 'error') return '失败';
		if (status === 'info') return '提示';
		return '进行中';
	}

	function progressDetail(detail?: ResourceGroupDeleteProgressEvent['detail']) {
		if (!detail) return '';
		const labels: Record<string, string> = {
			accountId: '账号',
			namespace: 'Provider',
			registrationState: '注册状态',
			resourceGroup: '资源组',
			index: '序号',
			total: '总数',
			status: 'Azure 状态',
			polls: '状态检查',
			subscriptionId: '订阅'
		};
		return Object.entries(detail)
			.map(([key, value]) => `${labels[key] ?? key}: ${value}`)
			.join(' · ');
	}

	async function loadAccounts() {
		accounts = await api<Account[]>('/api/user/azure/account/list');
		const fromUrl = Number(new URLSearchParams(location.search).get('account_id'));
		if (fromUrl && accounts.some((account) => account.id === fromUrl)) accountId = fromUrl;
		if (!accountId && accounts.length) accountId = accounts[0].id;
	}

	async function loadSubscriptions() {
		if (!accountId) {
			subscriptions = [];
			subscriptionId = '';
			return;
		}
		subscriptions = await api<Subscription[]>(
			`/api/user/azure/subscription/list?${new URLSearchParams({ account_id: String(accountId) })}`
		);
		if (!subscriptions.some((subscription) => subscription.subscription_id === subscriptionId)) {
			subscriptionId =
				subscriptions.find((subscription) => subscription.is_default)?.subscription_id ??
				subscriptions[0]?.subscription_id ??
				'';
		}
	}

	async function loadResources() {
		if (!accountId) return;
		loading = true;
		try {
			const query = params();
			if (resourceGroup) query.set('resource_group', resourceGroup);
			if (resourceType) query.set('resource_type', resourceType);
			const data = await api<{ groups: ResourceGroup[]; resources: Resource[] }>(
				`/api/user/azure/resource/groups?${query}`
			);
			groups = data.groups;
			resources = data.resources;
			selectedResourceGroups = selectedResourceGroups.filter((name) =>
				data.groups.some((group) => group.name === name)
			);
			if (resourceGroup && !groups.some((group) => group.name === resourceGroup)) resourceGroup = '';
			if (resourceGroup && selectedGroup) createAiForm.location = selectedGroup.location;
		} catch (err) {
			setToastFromError(err, '资源加载失败');
		} finally {
			loading = false;
		}
	}

	async function loadProviders() {
		if (!accountId) return;
		providerLoading = true;
		try {
			const data = await api<{ providers: ProviderStatus[] }>(
				`/api/user/azure/provider/list?${params()}`
			);
			providers = data.providers;
		} catch (err) {
			setToastFromError(err, 'Provider 状态查询失败');
		} finally {
			providerLoading = false;
		}
	}

	async function registerProviders() {
		if (!accountId) return;
		providerLoading = true;
		providerProgress = [
			{
				step: 'provider-submit',
				status: 'running',
				message: '正在提交 Provider 注册请求，页面会实时显示 Azure 返回的执行步骤',
				detail: { accountId, subscriptionId: subscriptionId || null },
				timestamp: new Date().toISOString()
			}
		];
		providerProgressResult = null;
		try {
			const result = await readProviderRegisterStream();
			providerProgressResult = result;
			providers = result.providers;
			const registered = result.providers.filter((provider) =>
				(provider.registrationState || '').toLowerCase().includes('registered')
			).length;
			toast = `Provider 注册流程完成：${registered}/${result.providers.length} 个已注册或已提交`;
		} catch (err) {
			mergeProviderProgress({
				step: 'provider-failed',
				status: 'error',
				message: err instanceof Error ? err.message : 'Provider 注册失败',
				timestamp: new Date().toISOString()
			});
			setToastFromError(err, 'Provider 注册失败');
		} finally {
			providerLoading = false;
		}
	}

	async function loadAiAccounts() {
		if (!accountId) return;
		aiLoading = true;
		try {
			const data = await api<{ accounts: AiAccount[] }>(
				`/api/user/azure/ai/account/list?${params()}`
			);
			aiAccounts = data.accounts;
			if (selectedAiAccount) {
				selectedAiAccount =
					aiAccounts.find(
						(account) =>
							account.name === selectedAiAccount?.name &&
							account.resource_group === selectedAiAccount?.resource_group
					) ?? null;
			}
		} catch (err) {
			setToastFromError(err, 'AI 账号加载失败');
		} finally {
			aiLoading = false;
		}
	}

	async function loadAiKeys(account: AiAccount) {
		if (!accountId) return;
		try {
			const query = params({
				resource_group: account.resource_group,
				ai_account_name: account.name
			});
			aiKeys = await api<AiKeys>(`/api/user/azure/ai/account/keys?${query}`);
			selectedAiAccount = account;
			toast = `${account.name} 的 endpoint 和 key 已加载`;
		} catch (err) {
			setToastFromError(err, 'AI key 查询失败');
		}
	}

	async function selectAiAccount(account: AiAccount) {
		selectedAiAccount = account;
		aiKeys = null;
		await loadDeployments();
	}

	async function loadDeployments() {
		if (!accountId || !selectedAiAccount) {
			deployments = [];
			return;
		}
		deploymentLoading = true;
		try {
			const query = params({
				resource_group: selectedAiAccount.resource_group,
				ai_account_name: selectedAiAccount.name
			});
			deployments = await api<AiDeployment[]>(`/api/user/azure/ai/deployment/list?${query}`);
		} catch (err) {
			setToastFromError(err, '模型部署加载失败');
		} finally {
			deploymentLoading = false;
		}
	}

	async function createAiAccount(e: Event) {
		e.preventDefault();
		if (!accountId) return;
		aiLoading = true;
		try {
			await api('/api/user/azure/ai/account/create', {
				method: 'POST',
				body: JSON.stringify({
					...createAiForm,
					account_id: accountId,
					subscription_id: subscriptionId
				})
			});
			toast = 'AI / Foundry 账号创建请求已提交';
			await Promise.all([loadAiAccounts(), loadResources()]);
		} catch (err) {
			setToastFromError(err, 'AI 账号创建失败');
		} finally {
			aiLoading = false;
		}
	}

	async function createDeployment(e: Event) {
		e.preventDefault();
		if (!accountId || !selectedAiAccount) return;
		deploymentLoading = true;
		try {
			await api('/api/user/azure/ai/deployment/create', {
				method: 'POST',
				body: JSON.stringify({
					...deploymentForm,
					account_id: accountId,
					subscription_id: subscriptionId,
					resource_group: selectedAiAccount.resource_group,
					ai_account_name: selectedAiAccount.name,
					capacity: Number(deploymentForm.capacity)
				})
			});
			toast = '模型部署创建请求已提交';
			await loadDeployments();
		} catch (err) {
			setToastFromError(err, '模型部署失败');
		} finally {
			deploymentLoading = false;
		}
	}

	async function changeAccount() {
		selectedAiAccount = null;
		aiKeys = null;
		deployments = [];
		await loadSubscriptions();
		await Promise.all([loadResources(), loadProviders(), loadAiAccounts()]);
	}

	async function changeSubscription() {
		selectedAiAccount = null;
		aiKeys = null;
		deployments = [];
		await Promise.all([loadResources(), loadProviders(), loadAiAccounts()]);
	}

	async function copy(value: string) {
		await navigator.clipboard.writeText(value);
		toast = '已复制到剪贴板';
	}

	async function readProviderRegisterStream() {
		const token = localStorage.getItem('token');
		const response = await fetch('/api/user/azure/provider/register', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/x-ndjson',
				...(token ? { Authorization: `Bearer ${token}` } : {})
			},
			body: JSON.stringify({ account_id: accountId, subscription_id: subscriptionId })
		});
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			throw new Error(body?.message ?? `Provider 注册请求失败 (${response.status})`);
		}
		if (!response.body) throw new Error('浏览器不支持读取 Provider 注册进度流');

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let result: ProviderRegisterStreamResult | null = null;

		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				const message = JSON.parse(line) as ProviderRegisterStreamMessage;
				if (message.type === 'progress') {
					mergeProviderProgress(message.event);
				} else if (message.type === 'result') {
					result = message.result;
				} else if (message.type === 'error') {
					throw new Error(message.message);
				}
			}
			if (done) break;
		}
		if (buffer.trim()) {
			const message = JSON.parse(buffer) as ProviderRegisterStreamMessage;
			if (message.type === 'progress') {
				mergeProviderProgress(message.event);
			} else if (message.type === 'result') {
				result = message.result;
			} else if (message.type === 'error') {
				throw new Error(message.message);
			}
		}
		if (!result) throw new Error('Provider 注册流程结束但未返回结果');
		return result;
	}

	async function readResourceGroupDeleteStream(resourceGroups: string[]) {
		const token = localStorage.getItem('token');
		const response = await fetch('/api/user/azure/resource/groups', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/x-ndjson',
				...(token ? { Authorization: `Bearer ${token}` } : {})
			},
			body: JSON.stringify({
				account_id: accountId,
				subscription_id: subscriptionId,
				resource_groups: resourceGroups
			})
		});
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			throw new Error(body?.message ?? `删除资源组请求失败 (${response.status})`);
		}
		if (!response.body) throw new Error('浏览器不支持读取删除进度流');

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let result: ResourceGroupDeleteStreamResult | null = null;

		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				const message = JSON.parse(line) as ResourceGroupDeleteStreamMessage;
				if (message.type === 'progress') {
					addDeleteProgress(message.event);
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

	async function deleteResourceGroups(resourceGroups: string[]) {
		if (!accountId || deletingGroups) return;
		const targets = uniqueNames(resourceGroups);
		if (targets.length === 0) {
			toast = '请先选择要删除的资源组';
			return;
		}
		deletingGroups = true;
		deleteProgress = [];
		deleteResults = [];
		toast = `正在并发提交 ${targets.length} 个资源组删除请求...`;
		try {
			const result = await readResourceGroupDeleteStream(targets);
			deleteResults = result.results;
			selectedResourceGroups = selectedResourceGroups.filter(
				(name) => !result.results.some((item) => item.resource_group === name && item.status === 'success')
			);
			if (resourceGroup && result.results.some((item) => item.resource_group === resourceGroup && item.status === 'success')) {
				resourceGroup = '';
			}
			toast = `资源组批量删除完成：成功 ${result.success} 个，失败 ${result.failed} 个`;
			await Promise.all([loadResources(), loadAiAccounts()]);
		} catch (err) {
			setToastFromError(err, '资源组删除失败');
		} finally {
			deletingGroups = false;
		}
	}

	onMount(async () => {
		await loadAccounts();
		if (accountId) await changeAccount();
	});
</script>

<h1 class="mb-4 text-2xl font-semibold">资源浏览 / Foundry AI</h1>

{#if toast}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm">{toast}</div>
{/if}

<div class="mb-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
	<section class="card space-y-4 p-5">
		<div class="flex flex-wrap items-end gap-3">
			<div>
				<label class="text-sm text-muted" for="resource-account">Azure 账号</label>
				<select
					id="resource-account"
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
				<label class="text-sm text-muted" for="resource-subscription">订阅</label>
				<select
					id="resource-subscription"
					class="input mt-1 min-w-[260px]"
					bind:value={subscriptionId}
					onchange={() => void changeSubscription()}
					disabled={!subscriptions.length}
				>
					{#if subscriptions.length === 0}
						<option value="">自动发现订阅中...</option>
					{:else}
						{#each subscriptions as subscription}
							<option value={subscription.subscription_id}>
								{subscription.display_name || subscription.subscription_id} ({subscription.state})
							</option>
						{/each}
					{/if}
				</select>
			</div>
			<button class="btn-primary" onclick={() => void changeSubscription()} disabled={loading}>
				刷新资源
			</button>
		</div>

		<div class="grid gap-3 md:grid-cols-2">
			<div>
				<label class="text-sm text-muted" for="resource-group-filter">资源组过滤</label>
				<select
					id="resource-group-filter"
					class="input mt-1"
					bind:value={resourceGroup}
					onchange={() => void loadResources()}
				>
					<option value="">全部资源组</option>
					{#each groups as group}
						<option value={group.name}>{group.name} - {group.location}</option>
					{/each}
				</select>
			</div>
			<div>
				<label class="text-sm text-muted" for="resource-type-filter">资源类型过滤</label>
				<select
					id="resource-type-filter"
					class="input mt-1"
					bind:value={resourceType}
					onchange={() => void loadResources()}
				>
					<option value="">全部类型</option>
					{#each resourceTypeOptions as type}
						<option value={type}>{type}</option>
					{/each}
				</select>
			</div>
		</div>

		<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background/60 p-3">
			<div class="text-sm">
				<div class="font-medium">资源组批量操作</div>
				<div class="mt-1 text-xs text-muted">
					已选择 {selectedResourceGroups.length} 个，当前列表 {visibleResourceGroups.length} 个资源组
				</div>
			</div>
			<div class="flex flex-wrap gap-2">
				<button
					class="btn-secondary"
					onclick={toggleVisibleResourceGroups}
					disabled={deletingGroups || visibleResourceGroups.length === 0}
				>
					{allVisibleResourceGroupsSelected ? '取消当前列表' : '全选当前列表'}
				</button>
				<button
					class="btn-secondary"
					onclick={clearResourceGroupSelection}
					disabled={deletingGroups || selectedResourceGroups.length === 0}
				>
					清空选择
				</button>
				<button
					class="btn-danger"
					onclick={() => void deleteResourceGroups(selectedResourceGroups)}
					disabled={deletingGroups || selectedResourceGroups.length === 0}
				>
					{deletingGroups ? '并行删除中...' : `删除选中 ${selectedResourceGroups.length} 个`}
				</button>
				<button
					class="btn-danger"
					onclick={() => void deleteResourceGroups(visibleResourceGroupNames)}
					disabled={deletingGroups || visibleResourceGroupNames.length === 0}
				>
					一键并行删除当前列表资源组
				</button>
			</div>
		</div>

		<div class="grid gap-3 md:grid-cols-3">
			{#each visibleResourceGroups as group}
				<div
					class={`rounded-lg border p-3 text-sm transition ${
						selectedResourceGroups.includes(group.name)
							? 'border-red-500/60 bg-red-500/10'
							: 'border-border hover:border-primary'
					}`}
				>
					<label class="mb-3 flex cursor-pointer items-center gap-2 text-xs text-muted">
						<input
							type="checkbox"
							class="h-4 w-4 accent-red-500"
							checked={selectedResourceGroups.includes(group.name)}
							disabled={deletingGroups}
							onchange={() => toggleResourceGroupSelection(group.name)}
						/>
						选择删除
					</label>
					<button
						class="w-full text-left"
						onclick={() => {
							resourceGroup = group.name;
							createAiForm.resource_group = group.name;
							createAiForm.location = group.location;
							void loadResources();
						}}
					>
						<div class="break-all font-medium">{group.name}</div>
						<div class="mt-1 text-xs text-muted">{group.location} / {group.count} resources</div>
						<div class="mt-1 text-xs text-muted">状态：{group.provisioning_state || '-'}</div>
					</button>
				</div>
			{/each}
			{#if visibleResourceGroups.length === 0}
				<div class="rounded-lg border border-border p-3 text-sm text-muted">暂无可操作资源组</div>
			{/if}
		</div>
	</section>

	<section class="card space-y-3 p-5">
		<div class="flex items-center justify-between gap-3">
			<div>
				<h2 class="text-lg font-medium">资源提供商</h2>
				<p class="mt-1 text-sm text-muted">新账号首次创建 VM 或 AI 资源前，建议先注册 Provider。</p>
			</div>
			<button class="btn-primary" onclick={() => void registerProviders()} disabled={providerLoading}>
				{providerLoading ? '处理中...' : '注册常用 Provider'}
			</button>
		</div>
		{#if providerLoading || providerProgress.length > 0}
			<div class="rounded-xl border border-primary/30 bg-background/70 p-4">
				<div class="mb-3 flex flex-wrap items-start justify-between gap-3">
					<div>
						<div class="text-sm font-medium">Provider 注册流程</div>
						<p class="mt-1 text-xs text-muted">
							正在按顺序检查、提交注册并写入缓存，过程中会实时显示每个 Azure Provider 的状态。
						</p>
					</div>
					<span
						class={`badge ${
							providerLoading
								? 'bg-yellow-900/50 text-yellow-300'
								: providerProgress.some((item) => item.status === 'error')
									? 'bg-red-900/50 text-red-300'
									: 'bg-green-900/50 text-green-300'
						}`}
					>
						{providerLoading ? '进行中' : providerProgress.some((item) => item.status === 'error') ? '有异常' : '已结束'}
					</span>
				</div>

				<div class={`progress-track ${providerProgressAnimation(providerProgress) || (providerLoading ? 'running' : '')}`}>
					<div
						class={`progress-fill ${providerProgressTone(providerProgress)}`}
						style={`width: ${providerProgressPercentValue}%`}
					></div>
				</div>
				<div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
					<span>进度：{providerProgressPercentValue}%</span>
					<span>已记录 {providerProgress.length} 个步骤</span>
				</div>

				{#if providerProgressResult}
					<div class="mt-3 rounded-lg border border-border bg-card/70 p-3 text-xs text-muted">
						订阅 {providerProgressResult.subscription_id} 已返回 {providerProgressResult.providers.length} 个 Provider 状态。
					</div>
				{/if}

				<div class="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
					{#each recentProviderProgress as item}
						<div class="rounded-lg border border-border/70 bg-card/70 p-3 text-sm">
							<div class="flex flex-wrap items-center gap-2">
								<span class={`badge ${progressBadge(item.status)}`}>{progressText(item.status)}</span>
								<span class="font-mono text-xs text-muted">{item.step}</span>
								<span>{item.message}</span>
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
		<div class="grid gap-2">
			{#each providers as provider}
				<div class="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
					<div>
						<div class="font-medium">{provider.namespace}</div>
						<div class="text-xs text-muted">{provider.resourceTypeCount} resource types</div>
					</div>
					<span
						class="badge {provider.registrationState.toLowerCase() === 'registered'
							? 'bg-green-900/50 text-green-300'
							: 'bg-yellow-900/50 text-yellow-300'}"
					>
						{provider.registrationState || '-'}
					</span>
				</div>
			{/each}
		</div>
	</section>
</div>

{#if deletingGroups || deleteProgress.length > 0}
	<section class="card mb-4 space-y-4 p-5">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<h2 class="text-lg font-medium">资源组删除进度</h2>
				<p class="mt-1 text-sm text-muted">
					删除请求已并发提交给 Azure，后续进度是在检查 Azure 后台清理是否完成，不会重复提交删除。
				</p>
			</div>
			<span class="badge {deletingGroups ? 'bg-yellow-900/50 text-yellow-300' : 'bg-green-900/50 text-green-300'}">
				{deletingGroups ? '并行删除中' : '已结束'}
			</span>
		</div>

		<div class={`progress-track ${progressAnimation(deleteProgress) || (deletingGroups ? 'running' : '')}`}>
			<div
				class={`progress-fill ${progressTone(deleteProgress)}`}
				style={`width: ${deleteProgressPercent}%`}
			></div>
		</div>
		<div class="flex justify-between text-xs text-muted">
			<span>进度：{deleteProgressPercent}%</span>
			<span>已记录 {deleteProgress.length} 个步骤</span>
		</div>

		{#if deleteResults.length > 0}
			<div class="grid gap-2 md:grid-cols-2">
				{#each deleteResults as result}
					<div class="rounded-lg border border-border bg-background/70 p-3 text-sm">
						<div class="flex items-center justify-between gap-2">
							<span class="break-all font-medium">{result.resource_group}</span>
							<span
								class={`badge ${
									result.status === 'success'
										? 'bg-green-900/50 text-green-300'
										: 'bg-red-900/50 text-red-300'
								}`}
							>
								{result.status === 'success' ? '成功' : '失败'}
							</span>
						</div>
						<div class="mt-2 break-all text-xs text-muted">{result.message}</div>
					</div>
				{/each}
			</div>
		{/if}

		<div class="max-h-72 space-y-2 overflow-y-auto rounded-lg border border-border bg-background/60 p-3">
			{#each recentDeleteProgress as item}
				<div class="rounded-lg border border-border/60 bg-card/70 p-3 text-sm">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<div class="font-medium">{item.message}</div>
						<span class={`badge ${progressBadge(item.status)}`}>{progressText(item.status)}</span>
					</div>
					{#if progressDetail(item.detail)}
						<div class="mt-1 break-all text-xs text-muted">{progressDetail(item.detail)}</div>
					{/if}
				</div>
			{/each}
		</div>
	</section>
{/if}

<section class="card mb-4 overflow-x-auto">
	<table class="w-full text-sm">
		<thead class="text-muted">
			<tr class="border-b border-border">
				<th class="p-3 text-left">名称</th>
				<th class="p-3 text-left">资源组</th>
				<th class="p-3 text-left">类型</th>
				<th class="p-3 text-left">区域</th>
				<th class="p-3 text-left">SKU / Kind</th>
				<th class="p-3 text-left">状态</th>
			</tr>
		</thead>
		<tbody>
			{#if loading}
				<tr><td class="p-3 text-muted" colspan="6">正在加载资源...</td></tr>
			{:else if resources.length === 0}
				<tr><td class="p-3 text-muted" colspan="6">暂无资源</td></tr>
			{:else}
				{#each resources as resource}
					<tr class="border-b border-border/60">
						<td class="max-w-[220px] break-all p-3">{resource.name}</td>
						<td class="p-3">{resource.resource_group}</td>
						<td class="max-w-[280px] break-all p-3">{resource.type}</td>
						<td class="p-3">{resource.location || '-'}</td>
						<td class="p-3">{resource.sku_name || resource.kind || '-'}</td>
						<td class="p-3">{resource.provisioning_state || '-'}</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</section>

<div class="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
	<section class="card space-y-4 p-5">
		<div class="flex items-center justify-between gap-3">
			<div>
				<h2 class="text-lg font-medium">Foundry / Azure AI 账号</h2>
				<p class="mt-1 text-sm text-muted">创建或管理 Microsoft.CognitiveServices/accounts。</p>
			</div>
			<button class="btn-secondary" onclick={() => void loadAiAccounts()} disabled={aiLoading}>
				刷新 AI
			</button>
		</div>

		<form class="grid gap-3 md:grid-cols-2" onsubmit={createAiAccount}>
			<input class="input" bind:value={createAiForm.resource_group} placeholder="资源组" required />
			<input class="input" bind:value={createAiForm.location} placeholder="区域，例如 eastus" required />
			<input class="input" bind:value={createAiForm.account_name} placeholder="AI 账号名称" required />
			<div class="grid grid-cols-2 gap-2">
				<input class="input" bind:value={createAiForm.kind} placeholder="Kind，例如 OpenAI" />
				<input class="input" bind:value={createAiForm.sku_name} placeholder="SKU，例如 S0" />
			</div>
			<button class="btn-primary md:col-span-2" type="submit" disabled={aiLoading}>
				{aiLoading ? '提交中...' : '创建 AI 账号'}
			</button>
		</form>

		<div class="grid gap-3">
			{#each aiAccounts as account}
				<div class="rounded-lg border border-border p-3 text-sm">
					<div class="flex items-start justify-between gap-3">
						<div>
							<div class="font-medium">{account.name}</div>
							<div class="mt-1 text-xs text-muted">
								{account.resource_group} / {account.location} / {account.kind || '-'} / {account.sku_name || '-'}
							</div>
							<div class="mt-1 break-all text-xs text-muted">{account.endpoint || '-'}</div>
						</div>
						<span class="badge bg-border text-white">{account.provisioning_state || '-'}</span>
					</div>
					<div class="mt-3 flex flex-wrap gap-2">
						<button class="btn-secondary px-2 py-1 text-xs" onclick={() => void selectAiAccount(account)}>
							查看部署
						</button>
						<button class="btn-secondary px-2 py-1 text-xs" onclick={() => void loadAiKeys(account)}>
							Endpoint / Key
						</button>
					</div>
				</div>
			{/each}
			{#if aiAccounts.length === 0}
				<p class="text-sm text-muted">当前订阅暂无 AI / Foundry 账号。</p>
			{/if}
		</div>
	</section>

	<section class="card space-y-4 p-5">
		<div>
			<h2 class="text-lg font-medium">模型部署</h2>
			<p class="mt-1 text-sm text-muted">
				{selectedAiAccount
					? `当前 AI 账号：${selectedAiAccount.name}`
					: '先在左侧选择一个 AI 账号。'}
			</p>
		</div>

		{#if aiKeys}
			{@const keys = aiKeys}
			<div class="rounded-lg border border-border bg-background p-3 text-xs">
				<div class="mb-2 flex items-center justify-between gap-2">
					<span class="font-medium text-sm">Endpoint / Keys</span>
					<button class="btn-secondary px-2 py-1 text-xs" onclick={() => void copy(keys.endpoint)}>
						复制 Endpoint
					</button>
				</div>
				<div class="break-all">Endpoint: {keys.endpoint || '-'}</div>
				<div class="mt-1 break-all">Key1: {keys.key1 || '-'}</div>
				<div class="mt-1 break-all">Key2: {keys.key2 || '-'}</div>
			</div>
		{/if}

		<form class="grid gap-3 md:grid-cols-2" onsubmit={createDeployment}>
			<input
				class="input"
				bind:value={deploymentForm.deployment_name}
				placeholder="部署名称，例如 gpt-4o-mini"
				required
				disabled={!selectedAiAccount}
			/>
			<input
				class="input"
				bind:value={deploymentForm.model_name}
				placeholder="模型名称，例如 gpt-4o-mini"
				required
				disabled={!selectedAiAccount}
			/>
			<input
				class="input"
				bind:value={deploymentForm.model_version}
				placeholder="模型版本，可留空"
				disabled={!selectedAiAccount}
			/>
			<div class="grid grid-cols-3 gap-2">
				<input class="input" bind:value={deploymentForm.model_format} placeholder="OpenAI" />
				<input class="input" bind:value={deploymentForm.scale_type} placeholder="Standard" />
				<input
					class="input"
					type="number"
					min="1"
					bind:value={deploymentForm.capacity}
					placeholder="容量"
				/>
			</div>
			<button
				class="btn-primary md:col-span-2"
				type="submit"
				disabled={!selectedAiAccount || deploymentLoading}
			>
				{deploymentLoading ? '处理中...' : '创建模型部署'}
			</button>
		</form>

		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead class="text-muted">
					<tr class="border-b border-border">
						<th class="p-2 text-left">部署</th>
						<th class="p-2 text-left">模型</th>
						<th class="p-2 text-left">容量</th>
						<th class="p-2 text-left">状态</th>
					</tr>
				</thead>
				<tbody>
					{#if deploymentLoading}
						<tr><td class="p-2 text-muted" colspan="4">正在加载部署...</td></tr>
					{:else if deployments.length === 0}
						<tr><td class="p-2 text-muted" colspan="4">暂无部署</td></tr>
					{:else}
						{#each deployments as deployment}
							<tr class="border-b border-border/60">
								<td class="p-2">{deployment.name}</td>
								<td class="p-2">
									{deployment.model_name}{deployment.model_version ? ` / ${deployment.model_version}` : ''}
								</td>
								<td class="p-2">{deployment.scale_type || '-'} / {deployment.capacity || '-'}</td>
								<td class="p-2">{deployment.provisioning_state || '-'}</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</section>
</div>
