<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Account = { id: number; name: string };
	type DnsBinding = { id: number; name: string; fqdn: string; enabled: boolean };
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
	let workflows = $state<Workflow[]>([]);
	let form = $state({
		account_id: '',
		name: '',
		resource_group: '',
		location: 'eastus',
		vm_names: '',
		min_running_count: 1,
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

	async function load() {
		accounts = await api<Account[]>('/api/user/azure/account/list');
		dnsBindings = await api<DnsBinding[]>('/api/user/dns/binding/list');
		workflows = await api<Workflow[]>('/api/user/workflow/list');
	}

	async function submit(e: Event) {
		e.preventDefault();
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
					min_running_count: Number(form.min_running_count),
					ip_brush_max_attempts: Number(form.ip_brush_max_attempts),
					check_interval_seconds: Number(form.check_interval_seconds),
					dns_binding_id: Number(form.dns_binding_id || 0),
					status_check_enabled: form.status_check_enabled,
					status_trigger_states: form.status_trigger_states
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
			toast = '请先选择 Azure 账号';
			return;
		}
		checkingStatus = true;
		statusResult = null;
		try {
			const params = new URLSearchParams({
				account_id: String(form.account_id),
				trigger_states: form.status_trigger_states
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
		toast = '已触发当前账号下的补机检查，请到执行日志查看结果';
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
		<select class="input" bind:value={form.account_id} required>
			<option value="">选择 Azure 账号</option>
			{#each accounts as account}
				<option value={account.id}>{account.name}</option>
			{/each}
		</select>
		<input class="input" bind:value={form.name} placeholder="策略名称" required />
		<input class="input" bind:value={form.resource_group} placeholder="资源组" required />
		<input class="input" bind:value={form.location} placeholder="区域" />
		<input
			class="input"
			bind:value={form.vm_names}
			placeholder="监控 VM（逗号分隔，留空表示全部）"
		/>
		<input
			class="input"
			type="number"
			bind:value={form.min_running_count}
			min="0"
			placeholder="最少运行数量"
		/>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={form.auto_start} /> 自动启动已停止的 VM
		</label>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={form.auto_create} /> 数量不足时自动创建新 VM
		</label>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={form.status_check_enabled} /> 自动定时检测账号/订阅状态
		</label>
		<div class="grid gap-3 sm:grid-cols-[1fr_auto]">
			<input
				class="input"
				bind:value={form.status_trigger_states}
				placeholder="触发补机状态，例如 banned,warning,warned"
			/>
			<button class="btn-secondary" type="button" disabled={checkingStatus} onclick={() => void checkAccountStatus()}>
				{checkingStatus ? '检测中...' : '检测账号状态'}
			</button>
		</div>
		{#if statusResult}
			<div
				class={`rounded-lg border px-3 py-2 text-xs ${
					statusResult.should_run_workflow
						? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
						: 'border-green-500/40 bg-green-500/10 text-green-100'
				}`}
			>
				订阅 {statusResult.display_name || statusResult.subscription_id} 当前状态：{statusResult.state}。
				{statusResult.should_run_workflow ? '命中触发条件，会执行补机流程。' : '未命中触发条件，不会执行补机。'}
			</div>
		{/if}
		<input class="input" bind:value={form.vm_size} placeholder="VM 规格" />
		<input
			class="input"
			bind:value={form.image_reference}
			placeholder="镜像 publisher:offer:sku:version"
		/>
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
							资源组 {workflow.resource_group} · 最少运行 {workflow.min_running_count}
						</p>
						<p class="text-xs text-muted">
							自动开机: {workflow.auto_start ? '是' : '否'} · 自动补机: {workflow.auto_create
								? '是'
								: '否'} · 间隔 {workflow.check_interval_seconds}s
						</p>
						<p class="text-xs text-muted">
							状态检测: {workflow.status_check_enabled ? '开启' : '关闭'} · 触发状态: {workflow.status_trigger_states || '-'} ·
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
