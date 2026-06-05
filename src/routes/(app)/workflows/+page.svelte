<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Account = { id: number; name: string };
	type Workflow = {
		id: number;
		name: string;
		enabled: boolean;
		resource_group: string;
		min_running_count: number;
		auto_start: boolean;
		auto_create: boolean;
		check_interval_seconds: number;
	};

	let accounts = $state<Account[]>([]);
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
		check_interval_seconds: 120
	});
	let toast = $state('');

	async function load() {
		accounts = await api<Account[]>('/api/user/azure/account/list');
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
					check_interval_seconds: Number(form.check_interval_seconds)
				})
			});
			toast = '补机策略已创建';
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : '创建失败';
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
		<input
			class="input"
			type="number"
			bind:value={form.check_interval_seconds}
			min="30"
			placeholder="检查间隔（秒）"
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
